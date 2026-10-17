import type {ConfigItem, ConfigService, ConfigValue, ReadonlyConfig} from "@lodestory/sdk/config";

type Values = Readonly<Record<string, ConfigValue>>;
type Options = {
  baseValues: Readonly<Record<string, unknown>>;
  userValues: Readonly<Record<string, unknown>>;
  persist: (values: Values) => void | Promise<void>;
  report?: (message: string, error?: unknown) => void;
};
type Entry = {
  id: string;
  source: object;
  validate: (value: unknown) => boolean;
  fallback: ConfigValue;
  value: ConfigValue;
  listeners: Set<() => void>;
  active: boolean;
};

const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);

/** Copy only unambiguous JSON data; never retain caller-owned mutable objects. */
function copyValue(value: unknown, ancestors = new Set<object>()): ConfigValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value === 0 ? 0 : value;
  if (!value || typeof value !== "object") throw new TypeError("Configuration values must be JSON data.");
  if (ancestors.has(value)) throw new TypeError("Configuration values cannot contain cycles.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        throw new TypeError("Configuration arrays cannot contain custom properties.");
      }
      const result: ConfigValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !own(descriptor, "value")) throw new TypeError("Configuration arrays cannot contain holes or accessors.");
        result.push(copyValue(descriptor.value, ancestors));
      }
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value);
    // Also accepts plain JSON objects from another realm (for example a host fixture).
    if (prototype !== null && (Object.getPrototypeOf(prototype) !== null || prototype.constructor?.name !== "Object")) {
      throw new TypeError("Configuration objects must be plain objects.");
    }
    const result: Record<string, ConfigValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !own(descriptor, "value")) {
        throw new TypeError("Configuration objects require enumerable string data properties.");
      }
      Object.defineProperty(result, key, {value: copyValue(descriptor.value, ancestors), enumerable: true});
    }
    return Object.freeze(result);
  } finally { ancestors.delete(value); }
}

function equalValue(left: ConfigValue, right: ConfigValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => own(right, key)
    && equalValue((left as Record<string, ConfigValue>)[key], (right as Record<string, ConfigValue>)[key]));
}

/** Application-level configuration, independent of UI and concrete persistence. */
export function createConfigStore(options: Options) {
  const entries = new Map<string, Entry>();
  const bindings = new Map<object, Entry>();
  const base: Record<string, ConfigValue> = Object.create(null);
  let users: Record<string, ConfigValue> = Object.create(null);
  let accepting = true;
  let sealed = false;
  let writes: Promise<void> = Promise.resolve();
  let disposal: Promise<void> | undefined;

  function report(message: string, error?: unknown) {
    try { (options.report ?? ((text, cause) => console.warn(text, cause)))(message, error); }
    catch { /* Reporting cannot change the result of a saved configuration write. */ }
  }
  for (const [id, value] of Object.entries(options.baseValues)) base[id] = copyValue(value);
  for (const [id, value] of Object.entries(options.userValues)) {
    try { users[id] = copyValue(value); }
    catch (error) { report(`Invalid saved configuration '${id}'; ignoring its value.`, error); }
  }

  function checkActive() {
    if (!accepting) throw new Error("Config service is no longer active.");
  }
  function lookup<T extends ConfigValue>(item: ConfigItem<T>): Entry {
    checkActive();
    const entry = item && bindings.get(item);
    if (!entry?.active || entries.get(entry.id) !== entry) throw new Error("Configuration item is not registered with this declaration.");
    return entry;
  }
  function checked(value: ConfigValue, validate: Entry["validate"], id: string, source: string) {
    try {
      if (validate(value) === true) return value;
    } catch (error) {
      throw Object.assign(new TypeError(`Invalid ${source} configuration '${id}'.`), {cause: error});
    }
    throw new TypeError(`Invalid ${source} configuration '${id}'.`);
  }
  function effective(entry: Entry) {
    if (!own(users, entry.id)) return entry.fallback;
    try { return checked(users[entry.id], entry.validate, entry.id, "saved"); }
    catch (error) {
      report(`Invalid saved configuration '${entry.id}'; using its application or default value.`, error);
      return entry.fallback;
    }
  }
  function publish(entry: Entry, value: ConfigValue) {
    if (!entry.active || equalValue(entry.value, value)) return;
    entry.value = value;
    for (const listener of [...entry.listeners]) {
      try { listener(); } catch (error) { report(`Configuration listener failed for '${entry.id}'.`, error); }
    }
  }
  function enqueue(entry: Entry, value: ConfigValue | undefined) {
    const operation = writes.then(async () => {
      // A queued request that never began saving cannot outlive its declaration.
      if (!entry.active) throw new Error(`Configuration '${entry.id}' was unregistered before saving.`);
      const next: Record<string, ConfigValue> = Object.assign(Object.create(null), users);
      if (value === undefined) delete next[entry.id];
      else next[entry.id] = value;
      await options.persist(Object.freeze(next));
      users = next;
      const current = entries.get(entry.id);
      // Persistence is keyed by ID. A replacement declaration revalidates saved data
      // using its own schema, rather than receiving the old entry's typed value.
      if (current) publish(current, effective(current));
    });
    writes = operation.catch(() => {});
    return operation;
  }

  const service: ConfigService = {
    register<T extends ConfigValue>(item: ConfigItem<T>) {
      checkActive();
      if (sealed) throw new Error("Configuration items must register before pluginsReady.");
      if (!item || typeof item.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(item.id)
        || (item.effect !== "live" && item.effect !== "restart") || typeof item.validate !== "function") {
        throw new TypeError("Configuration item requires a namespaced id, effect, and validator.");
      }
      if (entries.has(item.id) || bindings.has(item)) throw new Error(`Configuration '${item.id}' is already registered.`);
      const validate = item.validate;
      const defaultValue = checked(copyValue(item.defaultValue), validate, item.id, "default");
      const fallback = own(base, item.id) ? checked(base[item.id], validate, item.id, "application") : defaultValue;
      const entry: Entry = {id: item.id, source: item, validate, fallback, value: fallback, listeners: new Set(), active: true};
      entry.value = effective(entry);
      entries.set(entry.id, entry);
      bindings.set(item, entry);
      return () => {
        if (!entry.active) return;
        entry.active = false;
        entry.listeners.clear();
        if (entries.get(entry.id) === entry) entries.delete(entry.id);
        if (bindings.get(entry.source) === entry) bindings.delete(entry.source);
      };
    },
    getSnapshot<T extends ConfigValue>(item: ConfigItem<T>): ReadonlyConfig<T> {
      return lookup(item).value as ReadonlyConfig<T>;
    },
    set<T extends ConfigValue>(item: ConfigItem<T>, value: T): Promise<void> {
      try {
        const entry = lookup(item);
        return enqueue(entry, checked(copyValue(value), entry.validate, entry.id, "new"));
      } catch (error) { return Promise.reject(error); }
    },
    reset<T extends ConfigValue>(item: ConfigItem<T>): Promise<void> {
      try { return enqueue(lookup(item), undefined); }
      catch (error) { return Promise.reject(error); }
    },
    subscribe<T extends ConfigValue>(item: ConfigItem<T>, listener: () => void) {
      const entry = lookup(item);
      if (typeof listener !== "function") throw new TypeError("Configuration listener must be a function.");
      const subscription = () => listener();
      entry.listeners.add(subscription);
      return () => { entry.listeners.delete(subscription); };
    },
  };
  return {
    service: Object.freeze(service),
    seal() { checkActive(); sealed = true; },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      accepting = false;
      sealed = true;
      for (const entry of entries.values()) entry.listeners.clear();
      disposal = writes.then(() => {
        for (const entry of entries.values()) entry.active = false;
        entries.clear();
        bindings.clear();
      });
      return disposal;
    },
  };
}
