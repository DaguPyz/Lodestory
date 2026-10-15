import assert from "node:assert/strict";
import test from "node:test";
import { deferred, fixture } from "./helpers/themeFixture.mjs";

test("theme capability stays unavailable until native initialization finishes", async () => {
  const nativeReady = deferred();
  const f = fixture({ nativeSetGate: nativeReady.promise });
  await f.provideUi();
  await f.provideDefaults();
  const plugin = f.createThemePlugin();
  const mounting = f.core.mount(plugin);
  await Promise.resolve();
  await Promise.resolve();
  assert.throws(() => f.core.get(f.themeKey), /not registered/);
  nativeReady.resolve();
  await mounting;
  assert.equal(typeof f.core.get(f.themeKey).getSnapshot, "function");
  await f.core.unmount("theme");
  await f.core.unmount("builtin-themes");
  await f.core.unmount("test-ui");
});

test("registered theme service switches, notifies, cancels, retries, and unmounts cleanly", async () => {
  const f = fixture();
  await f.provideUi();
  await f.provideDefaults();
  const plugin = f.createThemePlugin();
  await f.core.mount(plugin);
  const service = f.core.get(f.themeKey);
  let notifications = 0;
  const unsubscribe = service.subscribe(() => { notifications += 1; });

  service.setPreference({ mode: "fixed", themeId: "lodestory.builtin.light" });
  assert.equal(service.getSnapshot().preference.themeId, "lodestory.builtin.light");
  assert.equal(service.getSnapshot().theme.type, "light");
  assert.equal(notifications, 1);
  unsubscribe();
  service.setPreference({ mode: "fixed", themeId: "lodestory.builtin.dark" });
  assert.equal(notifications, 1);

  f.controls.writeError = true;
  service.setPreference({ mode: "fixed", themeId: "lodestory.builtin.light" });
  assert.equal(service.getSnapshot().persistenceError, true);
  f.controls.writeError = false;
  service.retry();
  await Promise.resolve();
  assert.equal(service.getSnapshot().persistenceError, false);
  assert.deepEqual(JSON.parse(f.values.get("lodestory.theme-preference")), { mode: "fixed", themeId: "lodestory.builtin.light" });

  await f.core.unmount("theme");
  assert.throws(() => f.core.get(f.themeKey), /not registered/);
  assert.equal(f.uiRegistrations.find(({ kind, wrapper }) => kind === "wrapper" && wrapper.id === "theme").active, false);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.windowListenerCount("storage"), 0);
  assert.equal(f.channels[0].closed, true);
  assert.equal(f.nativeListeners.size, 0);
  plugin.deactivate();
  assert.equal(f.unlistenCalls, 1);

  await f.core.mount(plugin);
  assert.equal(f.core.get(f.themeKey).getSnapshot().preference.themeId, "lodestory.builtin.light");
  assert.equal(f.mediaListeners.size, 1);
  await f.core.unmount("theme");
  assert.equal(f.channels[1].closed, true);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.nativeListeners.size, 0);
  assert.equal(f.unlistenCalls, 2);
  await f.core.unmount("builtin-themes");
  await f.core.unmount("test-ui");
});

test("capability commit conflict fails activation and cleans theme platform resources", async () => {
  const f = fixture();
  await f.provideUi();
  await f.provideDefaults();
  const conflictingProvider = {
    id: "existing-theme",
    requires: [],
    provides: [f.themeKey],
    activate(context) {
      context.provide(f.themeKey, {
        getSnapshot() {}, subscribe() {}, setPreference() {}, registerTheme() {}, retry() {},
      });
    },
  };
  await f.core.mount(conflictingProvider);

  await assert.rejects(f.core.mount(f.createThemePlugin()), /already registered/);
  assert.equal(f.core.isMounted("theme"), false);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.windowListenerCount("storage"), 0);
  assert.equal(f.channels[0].closed, true);
  assert.equal(typeof f.core.get(f.themeKey).getSnapshot, "function");
  const failedWrapper = f.uiRegistrations.find(({ kind, wrapper }) => kind === "wrapper" && wrapper.id === "theme");
  assert.equal(failedWrapper.active, false, "commit failure removes the wrapper registered earlier in activation");
  assert.deepEqual(f.uiLifecycle.slice(-2), ["remove:theme", "stop-theme-sync"]);
  await f.core.unmount("existing-theme");
  await f.core.unmount("builtin-themes");
  await f.core.unmount("test-ui");
});

test("native listener resolving after unmount is immediately removed", async () => {
  const nativeRegistration = deferred();
  const f = fixture({ nativeListenerGate: nativeRegistration.promise });
  await f.provideUi();
  await f.provideDefaults();
  await f.core.mount(f.createThemePlugin());
  assert.equal(f.nativeListeners.size, 0);
  await f.core.unmount("theme");

  nativeRegistration.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.nativeListeners.size, 0);
  assert.equal(f.unlistenCalls, 1);
  await f.core.unmount("builtin-themes");
  await f.core.unmount("test-ui");
});

test("native setTheme failure is retained in the snapshot without failing plugin mount", async () => {
  const f = fixture({ nativeSetError: true });
  await f.provideUi();
  await f.provideDefaults();
  await f.core.mount(f.createThemePlugin());
  assert.equal(f.core.isMounted("theme"), true);
  assert.equal(f.core.get(f.themeKey).getSnapshot().windowError, true);
  await f.core.unmount("theme");
  await f.core.unmount("builtin-themes");
  await f.core.unmount("test-ui");
});

test("theme plugin registers the same ThemeService through the real ThemeProvider and removes it before stopping sync", async () => {
  const f = fixture();
  await f.provideUi();
  await f.provideDefaults();
  const plugin = f.createThemePlugin();
  assert.equal(plugin.requires[0], f.uiKey);
  await f.core.mount(plugin);

  const registration = f.uiRegistrations.find(({ kind, wrapper }) => kind === "wrapper" && wrapper.id === "theme");
  assert.ok(registration);
  assert.equal(registration.wrapper.order, 20);
  const service = f.core.get(f.themeKey);
  function Probe() {
    return f.React.createElement("span", {
      "data-same-service": String(f.useThemeService() === service),
      children: "themed",
    });
  }
  const wrapped = registration.wrapper.wrap(f.React.createElement(Probe));
  assert.equal(wrapped.type, f.ThemeProvider);
  assert.equal(wrapped.props.service, service);
  assert.match(f.renderToStaticMarkup(wrapped), /data-same-service="true"/);

  await f.core.unmount("theme");
  assert.deepEqual(f.uiLifecycle.slice(-2), ["remove:theme", "stop-theme-sync"]);
  await f.core.unmount("builtin-themes");
  await f.core.unmount("test-ui");
});

test("theme sync stops even when removing the mounted wrapper throws", async () => {
  const f = fixture();
  await f.provideUi();
  await f.provideDefaults();
  await f.core.mount(f.createThemePlugin());
  f.controls.uiDisposeError = true;

  await assert.rejects(f.core.unmount("theme"), /UI wrapper disposer failed/);
  assert.deepEqual(f.uiLifecycle.slice(-2), ["remove:theme", "stop-theme-sync"]);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.windowListenerCount("storage"), 0);
  assert.equal(f.channels[0].closed, true);
  assert.throws(() => f.core.get(f.themeKey), /not registered/);

  f.controls.uiDisposeError = false;
  await f.core.unmount("builtin-themes");
  await f.core.unmount("test-ui");
});

test("settings renders registered custom themes as peers with their own preview palette", async () => {
  const f = fixture();
  await f.provideUi();
  await f.provideDefaults();
  await f.core.mount(f.createThemePlugin());
  const service = f.core.get(f.themeKey);
  const remove = service.registerTheme({ schemaVersion: 1, id: "example.custom.ink", name: "墨色写作", type: "dark", colors: { "surface.content": "#171A23" } });
  service.setPreference({ mode: "fixed", themeId: "example.custom.ink" });
  const { ThemeSettingsPage } = f.loadModule("plugins/settings/ThemeSettingsPage.tsx");
  const render = () => f.renderToStaticMarkup(f.React.createElement(f.ThemeProvider, { service }, f.React.createElement(ThemeSettingsPage, { active: false, onBack() {} })));
  const html = render();
  assert.match(html, /value="lodestory.builtin.dark"/);
  assert.match(html, /value="lodestory.builtin.light"/);
  assert.match(html, /checked="" value="example.custom.ink"/);
  assert.match(html, /data-ui-theme-id="example.custom.ink" style="[^"]*--ui-surface-workspace:#171A23/);
  assert.match(html, /当前使用「墨色写作」/);
  remove();
  assert.doesNotMatch(render(), /value="example.custom.ink"/);
  assert.match(render(), /所选主题暂不可用/);
  await f.core.unmount("theme");
  await f.core.unmount("builtin-themes");
  await f.core.unmount("test-ui");
});

test("theme factories wait for default contributions before creating platform state", async () => {
  const f = fixture();
  await f.provideUi();
  const managerPlugin = f.createThemePlugin();
  const builtinPlugin = f.createBuiltinThemesPlugin();
  assert.deepEqual(f.root.dataset, {});
  assert.equal(f.channels.length, 0);
  await assert.rejects(f.core.mount(managerPlugin), /app\/theme-defaults.*not registered/);
  assert.deepEqual(f.root.dataset, {});
  assert.equal(f.mediaListeners.size, 0);

  // Deliberately reversed: the shared capability dependency determines activation order.
  await f.core.mountAll([managerPlugin, builtinPlugin]);
  const service = f.core.get(f.themeKey);
  assert.equal(service.getSnapshot().themes.length, 2);
  assert.equal(service.getSnapshot().theme.id, "lodestory.builtin.dark");
  await assert.rejects(f.core.unmount("builtin-themes"), /required by plugins: 'theme'/);
  assert.equal(service.getSnapshot().theme.id, "lodestory.builtin.dark");
  await f.core.unmountAll();
  assert.throws(() => f.core.get(f.themeDefaultsKey), /not registered/);
  assert.equal(f.mediaListeners.size, 0);
});

test("an alternative defaults plugin supplies all IDs, migration, fallbacks and settings previews", async () => {
  const f = fixture({ saved: "system", system: "light" });
  const defaults = {
    dark: { schemaVersion: 1, id: "example.defaults.ink", name: "默认墨色", type: "dark", colors: { "surface.content": "#112233" } },
    light: { schemaVersion: 1, id: "example.defaults.paper", name: "默认纸色", type: "light", colors: { "surface.content": "#DDEEFF" } },
  };
  await f.provideUi();
  await f.provideDefaults(defaults);
  await f.core.mount(f.createThemePlugin());
  const service = f.core.get(f.themeKey);
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.theme.id, defaults.light.id);
  assert.equal(snapshot.preference.lightThemeId, defaults.light.id);
  assert.equal(snapshot.preference.darkThemeId, defaults.dark.id);
  assert.equal(snapshot.defaultThemeIds.dark, defaults.dark.id);
  assert.equal(Object.isFrozen(snapshot.defaultThemeIds), true);
  assert.equal(f.root.style["--ui-surface-workspace"], "#DDEEFF");
  assert.equal(snapshot.themes.some(theme => theme.id.startsWith("lodestory.builtin.")), false);

  const { ThemeSettingsPage } = f.loadModule("plugins/settings/ThemeSettingsPage.tsx");
  const render = () => f.renderToStaticMarkup(f.React.createElement(f.ThemeProvider, { service }, f.React.createElement(ThemeSettingsPage, { active: false, onBack() {} })));
  assert.match(render(), /value="example.defaults.paper"/);
  assert.match(render(), /--ui-surface-workspace:#DDEEFF/);
  assert.doesNotMatch(render(), /lodestory\.builtin/);

  let remove;
  const contributed = { ...defaults.light, id: "example.custom.paper", name: "自定义纸色" };
  await f.core.mount({
    id: "custom-theme", requires: [f.themeKey], provides: [],
    activate(context) { remove = context.get(f.themeKey).registerTheme(contributed); },
    deactivate() { remove?.(); },
  });
  service.setPreference({ mode: "fixed", themeId: contributed.id });
  assert.equal(service.getSnapshot().theme.id, contributed.id);
  await f.core.unmount("custom-theme");
  assert.equal(service.getSnapshot().theme.id, defaults.light.id);
  assert.equal(service.getSnapshot().unavailableThemeId, contributed.id);
  assert.match(render(), /所选主题暂不可用/);
  await f.core.unmountAll();
});

test("invalid default contributions fail before DOM or platform listeners are initialized", async () => {
  const f = fixture();
  const dark = { schemaVersion: 1, id: "example.defaults.dark", name: "Dark", type: "dark", colors: {} };
  await f.provideUi();
  await f.provideDefaults({ dark, light: { ...dark, id: "example.defaults.light" } });
  await assert.rejects(f.core.mount(f.createThemePlugin()), /Missing light fallback theme/);
  assert.deepEqual(f.root.dataset, {});
  assert.equal(f.channels.length, 0);
  assert.equal(f.mediaListeners.size, 0);
  assert.throws(() => f.core.get(f.themeKey), /not registered/);
  await f.core.unmountAll();
});

test("remounting creates a fresh catalog and isolates old services and pending native calls", async () => {
  const f = fixture();
  await f.provideUi();
  await f.provideDefaults();
  const plugin = f.createThemePlugin();
  await f.core.mount(plugin);
  const oldService = f.core.get(f.themeKey);
  const definition = { schemaVersion: 1, id: "example.custom.night", name: "Night", type: "dark", colors: {} };
  const removeOld = oldService.registerTheme(definition);
  const delay = deferred();
  f.controls.nativeDelay = delay.promise;
  oldService.setPreference({ mode: "fixed", themeId: "lodestory.builtin.light" });
  await Promise.resolve();
  oldService.setPreference({ mode: "fixed", themeId: definition.id });
  await f.core.unmount("theme");
  const mounting = f.core.mount(plugin);
  await Promise.resolve();
  delay.resolve();
  await mounting;
  const service = f.core.get(f.themeKey);
  assert.notEqual(service, oldService);
  assert.equal(service.getSnapshot().themes.length, 2);
  assert.equal(service.getSnapshot().unavailableThemeId, definition.id);
  assert.equal(f.nativeTheme(), "dark", "the old light request must complete before the new dark request");
  service.registerTheme(definition);
  assert.equal(service.getSnapshot().theme.id, definition.id);
  removeOld();
  assert.equal(service.getSnapshot().theme.id, definition.id);
  assert.equal(f.root.dataset.uiThemeId, definition.id, "old catalog changes cannot repaint the new manager's DOM");
  assert.equal(f.mediaListeners.size, 1);
  assert.equal(f.nativeListeners.size, 1);
  await f.core.unmountAll();
});
