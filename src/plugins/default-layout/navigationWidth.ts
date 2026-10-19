import type {ConfigItem, ConfigService} from "@lodestory/sdk/config";

export const MIN_NAVIGATION_WIDTH = 200;
export const MAX_NAVIGATION_WIDTH = 480;
export const DEFAULT_NAVIGATION_WIDTH = 256;

export type NavigationWidthPreference = number | null;

export const navigationWidthConfig: ConfigItem<NavigationWidthPreference> = Object.freeze({
  id: "defaultLayout.navigationWidth",
  defaultValue: null,
  effect: "live",
  validate(value: unknown): value is NavigationWidthPreference {
    return value === null || (typeof value === "number" && Number.isFinite(value)
      && value >= MIN_NAVIGATION_WIDTH && value <= MAX_NAVIGATION_WIDTH);
  },
});

export type NavigationWidthEnvironment = Readonly<{
  /** Available sidebar width after preserving room for the main content. */
  availableWidth: number;
  /** Current CSS width of the theme's 16rem default. */
  defaultWidth: number;
}>;

export type NavigationWidthSnapshot = Readonly<{
  preferredWidth: NavigationWidthPreference;
  effectiveWidth: number;
  availableWidth: number;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}>;

/** Keeps the user's preferred width separate from the width allowed by the current container. */
export function createNavigationWidthModel(config: ConfigService) {
  let disposed = false;
  const unregister = config.register(navigationWidthConfig);
  let preferredWidth = config.getSnapshot(navigationWidthConfig);
  let draftWidth: number | null = null;
  let availableWidth = 0;
  let defaultWidth = DEFAULT_NAVIGATION_WIDTH;
  let writeRevision = 0;
  let pendingWrites = 0;
  const listeners = new Set<() => void>();

  function bounds() {
    const maxWidth = Math.min(MAX_NAVIGATION_WIDTH, availableWidth);
    return {minWidth: Math.min(MIN_NAVIGATION_WIDTH, maxWidth), maxWidth};
  }

  function createSnapshot(): NavigationWidthSnapshot {
    const {minWidth, maxWidth} = bounds();
    const desiredWidth = draftWidth ?? preferredWidth ?? defaultWidth;
    return Object.freeze({
      preferredWidth,
      effectiveWidth: Math.max(minWidth, Math.min(maxWidth, desiredWidth)),
      availableWidth,
      defaultWidth,
      minWidth,
      maxWidth,
    });
  }

  let snapshot = createSnapshot();

  function publish() {
    if (disposed) return;
    const next = createSnapshot();
    if (Object.keys(next).every(key => next[key as keyof NavigationWidthSnapshot] === snapshot[key as keyof NavigationWidthSnapshot])) return;
    snapshot = next;
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(); }
      catch (error) { console.error("Navigation width subscriber failed.", {error}); }
    }
  }

  const unsubscribeConfig = config.subscribe(navigationWidthConfig, () => {
    if (disposed || pendingWrites > 0) return;
    preferredWidth = config.getSnapshot(navigationWidthConfig);
    publish();
  });

  function persist(next: NavigationWidthPreference, save: () => Promise<void>): Promise<void> {
    const revision = ++writeRevision;
    pendingWrites++;
    preferredWidth = next;
    draftWidth = null;
    publish();
    let operation: Promise<void>;
    try { operation = save(); }
    catch (error) {
      pendingWrites--;
      return Promise.reject(error);
    }
    return Promise.resolve(operation).then(() => {
      pendingWrites--;
      if (disposed || revision !== writeRevision) return;
      // Reset may restore an application default without emitting a change.
      // Keep a newer drag preview while accepting the completed preference.
      preferredWidth = config.getSnapshot(navigationWidthConfig);
      publish();
    }, error => {
      pendingWrites--;
      // A failed save keeps the current session width; the caller reports it.
      throw error;
    });
  }

  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setEnvironment(environment: NavigationWidthEnvironment) {
      if (disposed) return;
      if (!Number.isFinite(environment.availableWidth) || !Number.isFinite(environment.defaultWidth)) return;
      availableWidth = Math.max(0, environment.availableWidth);
      defaultWidth = Math.max(0, environment.defaultWidth);
      publish();
    },
    previewWidth(width: number) {
      if (disposed) return;
      if (!Number.isFinite(width)) return;
      const {minWidth, maxWidth} = bounds();
      draftWidth = Math.max(minWidth, Math.min(maxWidth, width));
      publish();
    },
    commitWidth(): Promise<void> {
      if (disposed || draftWidth === null) return Promise.resolve();
      const next = Math.max(MIN_NAVIGATION_WIDTH, Math.min(MAX_NAVIGATION_WIDTH, draftWidth));
      return persist(next, () => config.set(navigationWidthConfig, next));
    },
    cancelPreview() {
      if (disposed) return;
      draftWidth = null;
      publish();
    },
    reset(): Promise<void> {
      if (disposed) return Promise.resolve();
      return persist(null, () => config.reset(navigationWidthConfig));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { unsubscribeConfig(); }
      finally {
        try { unregister(); }
        finally { listeners.clear(); }
      }
    },
  };
}

export type NavigationWidthModel = ReturnType<typeof createNavigationWidthModel>;
