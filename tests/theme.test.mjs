import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { fixture as createFixture, deferred } from "./helpers/themeFixture.mjs";

const bootstrap = await readFile(new URL("../public/theme-bootstrap.js", import.meta.url), "utf8");
const generatedCss = await readFile(new URL("../src/styles/theme-colors.css", import.meta.url), "utf8");
const key = "lodestory.theme-preference";
const fixed = type => ({ mode: "fixed", themeId: `lodestory.builtin.${type}` });
const systemPreference = { mode: "system", lightThemeId: "lodestory.builtin.light", darkThemeId: "lodestory.builtin.dark" };
const fixture = options => createFixture({ desktop: false, ...options });
const custom = (id = "example.custom.ink", type = "dark", colors = {}) => ({ schemaVersion: 1, id, name: "墨色", type, colors });
const plain = value => JSON.parse(JSON.stringify(value));

test("first paint and runtime agree on legacy migration, IDs, system choice and invalid preferences", () => {
  const cases = [
    { saved: null, system: "light", expected: "dark" },
    { saved: "light", system: "dark", expected: "light" },
    { saved: "dark", system: "light", expected: "dark" },
    { saved: "system", system: "light", expected: "light" },
    { saved: "system", system: "dark", expected: "dark" },
    { saved: "unknown", system: "light", expected: "dark" },
    { saved: "light", readError: true, expected: "dark" },
    { preference: fixed("light"), expected: "light" },
    { preference: systemPreference, system: "light", expected: "light" },
    { preference: "{", saved: "light", expected: "dark" },
    { preference: { ...systemPreference, lightThemeId: "lodestory.builtin.dark" }, system: "light", expected: "dark" },
    { preference: { mode: "fixed", themeId: "example.missing.theme" }, expected: "dark" },
    { preference: { ...systemPreference, lightThemeId: "example.missing.theme" }, system: "light", expected: "light" },
  ];
  for (const entry of cases) {
    const f = fixture(entry);
    const root = { dataset: {}, style: {} };
    vm.runInNewContext(bootstrap, {
      document: { documentElement: root },
      window: {
        localStorage: { getItem(name) { if (entry.readError) throw new Error("blocked"); return f.values.get(name) ?? null; } },
        matchMedia() { return { matches: entry.system === "light" }; },
      },
    });
    const snapshot = f.api.getThemeSnapshot();
    assert.equal(snapshot.theme.type, entry.expected);
    assert.equal(root.dataset.uiTheme, entry.expected);
    assert.equal(root.dataset.uiThemeId, snapshot.theme.id);
    assert.equal(root.style.colorScheme, entry.expected);
    assert.equal(root.style.backgroundColor, snapshot.theme.colors["surface.content"]);
  }
});

test("generated first-paint CSS agrees with both runtime-resolved builtins", () => {
  const f = fixture();
  for (const theme of f.api.getThemeSnapshot().themes) {
    const block = generatedCss.split(`[data-ui-theme-id="${theme.id}"] {`)[1]?.split("}")[0];
    assert.ok(block);
    const vars = Object.fromEntries([...block.matchAll(/(--ui-[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]]));
    assert.deepEqual(vars, plain(theme.cssVariables));
  }
});

test("themes with the same type are peers and switch their entire palettes by ID", () => {
  const f = fixture();
  const definition = custom(undefined, "dark", { "surface.content": "#171A23", "state.selectedForeground": "#AABBCC" });
  const remove = f.api.registerTheme(definition);
  definition.colors["surface.content"] = "#FFFFFF";
  let notifications = 0;
  const unsubscribe = f.api.subscribeTheme(() => { notifications++; });
  f.api.setThemePreference({ mode: "fixed", themeId: definition.id });
  const snapshot = f.api.getThemeSnapshot();
  assert.equal(snapshot.themes.length, 3);
  assert.equal(snapshot.theme.id, definition.id);
  assert.equal(snapshot.theme.type, "dark");
  assert.equal(snapshot.theme.colors["surface.content"], "#171A23", "registered data is copied");
  assert.equal(snapshot.theme.colors["state.selectedHoverForeground"], "#AABBCC", "missing roles follow standard references");
  assert.equal(f.root.style["--ui-surface-workspace"], "#171A23");
  assert.equal(f.root.dataset.uiThemeId, definition.id);
  assert.equal(Object.keys(snapshot.theme.colors).length, 108);
  assert.equal(Object.isFrozen(snapshot.theme.colors), true);
  assert.equal(notifications, 1);
  f.api.setThemePreference(fixed("dark"));
  assert.equal(f.root.style["--ui-surface-workspace"], "#14181D");
  assert.notEqual(f.api.getThemeSnapshot().theme.colors["state.selectedHoverForeground"], "#AABBCC");
  unsubscribe();
  remove();
});

test("missing colors come from standard defaults, never another theme's palette", () => {
  const f = fixture();
  const { createThemeManager } = f.loadModule("plugins/theme/themeManager.ts");
  const dark = custom("example.test.dark", "dark", { "surface.content": "#111111" });
  const light = custom("example.test.light", "light", {});
  const manager = createThemeManager({ defaultThemeId: dark.id, fallbackThemeIds: { dark: dark.id, light: light.id } }, { mode: "fixed", themeId: dark.id }, "dark");
  manager.registerTheme(dark);
  manager.registerTheme(light);
  manager.start();
  manager.registerTheme(custom());
  manager.setPreference({ mode: "fixed", themeId: custom().id });
  assert.equal(manager.getSnapshot().theme.colors["surface.content"], "#14181D");
});

test("duplicate IDs, invalid colors and incompatible system slots leave the catalog unchanged", () => {
  const f = fixture();
  const before = f.api.getThemeSnapshot();
  for (const definition of [
    custom("lodestory.builtin.dark"),
    custom("invalid"),
    { ...custom(), type: "system" },
    custom(undefined, "dark", { "unknown.color": "#FFFFFF" }),
    custom(undefined, "dark", { "surface.content": "#FFFFFF00" }),
    custom(undefined, "dark", { "surface.content": "red" }),
  ]) assert.throws(() => f.api.registerTheme(definition));
  assert.throws(() => f.api.setThemePreference({ mode: "fixed", themeId: "example.missing.theme" }), /not registered/);
  assert.throws(() => f.api.setThemePreference({ ...systemPreference, lightThemeId: "lodestory.builtin.dark" }), /requires a light theme/);
  assert.equal(f.api.getThemeSnapshot(), before);
});

test("removing a selected theme uses the configured fallback and restores it on registration", () => {
  const f = fixture();
  const definition = custom(undefined, "light");
  const remove = f.api.registerTheme(definition);
  f.api.setThemePreference({ mode: "fixed", themeId: definition.id });
  remove();
  assert.equal(f.api.getThemeSnapshot().theme.id, "lodestory.builtin.light");
  assert.equal(f.api.getThemeSnapshot().unavailableThemeId, definition.id);
  assert.equal(f.api.getThemeSnapshot().preference.themeId, definition.id);
  const removeAgain = f.api.registerTheme(definition);
  assert.equal(f.api.getThemeSnapshot().theme.id, definition.id);
  assert.equal(f.api.getThemeSnapshot().unavailableThemeId, null);
  remove(); // An old disposer must not remove a new registration.
  assert.equal(f.api.getThemeSnapshot().theme.id, definition.id);
  removeAgain();
});

test("a saved custom ID resolves when its plugin registers after startup", () => {
  const f = fixture({ preference: { mode: "fixed", themeId: custom().id } });
  assert.equal(f.api.getThemeSnapshot().unavailableThemeId, custom().id);
  f.api.registerTheme(custom());
  assert.equal(f.api.getThemeSnapshot().theme.id, custom().id);
  assert.equal(f.api.getThemeSnapshot().unavailableThemeId, null);
});

test("manual selection ignores system changes while system mode uses independently chosen themes", () => {
  const f = fixture({ saved: "light" });
  const stop = f.api.startThemeSync();
  const dark = custom();
  const light = custom("example.custom.paper", "light");
  f.api.registerTheme(dark);
  f.api.registerTheme(light);
  f.api.setThemePreference({ mode: "fixed", themeId: dark.id });
  f.changeSystem("light");
  assert.equal(f.api.getThemeSnapshot().theme.id, dark.id);
  f.api.setThemePreference({ mode: "system", darkThemeId: dark.id, lightThemeId: light.id });
  assert.equal(f.api.getThemeSnapshot().theme.id, light.id);
  f.changeSystem("dark");
  assert.equal(f.api.getThemeSnapshot().preference.mode, "system");
  assert.equal(f.api.getThemeSnapshot().theme.id, dark.id);
  stop();
  f.changeSystem("light");
  assert.equal(f.api.getThemeSnapshot().theme.id, dark.id);
});

test("save failure preserves the session choice and retry clears the error", () => {
  const f = fixture();
  const stop = f.api.startThemeSync();
  f.controls.writeError = true;
  f.api.setThemePreference(fixed("light"));
  assert.equal(f.api.getThemeSnapshot().theme.type, "light");
  assert.equal(f.api.getThemeSnapshot().persistenceError, true);
  assert.equal(f.channels[0].messages[0].persistenceError, true);
  f.controls.writeError = false;
  f.api.retryTheme();
  assert.equal(f.api.getThemeSnapshot().persistenceError, false);
  assert.deepEqual(JSON.parse(f.values.get(key)), fixed("light"));
  stop();
});

test("storage and channel synchronize validated preferences, including themes not yet registered", () => {
  const f = fixture();
  const stop = f.api.startThemeSync();
  f.storageEvent(JSON.stringify(fixed("light")), {});
  assert.equal(f.api.getThemeSnapshot().theme.type, "dark");
  f.storageEvent(JSON.stringify(fixed("light")));
  assert.equal(f.api.getThemeSnapshot().theme.type, "light");
  f.storageEvent("unknown");
  assert.equal(f.api.getThemeSnapshot().theme.type, "dark");
  f.channels[0].onmessage({ data: { preference: { mode: "invalid" } } });
  assert.equal(f.api.getThemeSnapshot().theme.type, "dark");
  f.channels[0].onmessage({ data: { preference: { mode: "fixed", themeId: custom().id }, persistenceError: true } });
  assert.equal(f.api.getThemeSnapshot().unavailableThemeId, custom().id);
  assert.equal(f.api.getThemeSnapshot().persistenceError, true);
  f.api.registerTheme(custom());
  assert.equal(f.api.getThemeSnapshot().theme.id, custom().id);
  stop();
  assert.equal(f.channels[0].closed, true);
  assert.equal(f.channels[0].onmessage, null);
});

test("desktop system mode releases native override before resolving system appearance", async () => {
  const f = fixture({ saved: "dark", desktop: true, system: "light" });
  const stop = f.api.startThemeSync();
  await f.api.whenNativeThemeReady();
  f.api.setThemePreference(systemPreference);
  await f.api.whenNativeThemeReady();
  assert.equal(f.nativeCalls.at(-1), null);
  assert.equal(f.nativeTheme(), "light");
  assert.equal(f.api.getThemeSnapshot().theme.type, "light");
  stop();
});

test("delayed native requests cannot overwrite a newer choice or mutate state after unmount", async () => {
  const f = fixture({ desktop: true });
  const stop = f.api.startThemeSync();
  await f.api.whenNativeThemeReady();
  const delay = deferred();
  f.controls.nativeDelay = delay.promise;
  f.api.setThemePreference(fixed("light"));
  await Promise.resolve();
  f.api.setThemePreference(fixed("dark"));
  delay.resolve();
  await f.api.whenNativeThemeReady();
  assert.equal(f.nativeTheme(), "dark");
  assert.equal(f.root.dataset.uiTheme, "dark");
  const pending = deferred();
  f.controls.nativeDelay = pending.promise;
  f.controls.nativeSetError = true;
  f.api.setThemePreference(fixed("light"));
  await Promise.resolve();
  stop();
  const before = f.api.getThemeSnapshot();
  pending.resolve();
  await f.api.whenNativeThemeReady();
  assert.equal(f.api.getThemeSnapshot(), before);
});
