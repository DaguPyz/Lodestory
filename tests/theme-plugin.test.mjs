import assert from "node:assert/strict";
import test from "node:test";
import { deferred, fixture } from "./helpers/themeFixture.mjs";

const darkId = "lodestory.builtin.dark";
const lightId = "lodestory.builtin.light";
const fixed = themeId => ({ mode: "fixed", themeId });
const definition = (id = "example.custom.ink", type = "dark", colors = {}) => ({ schemaVersion: 1, id, name: "自定义墨色", type, colors });
async function mount(f) {
  await f.provideUi();
  const plugin = f.createThemePlugin();
  await f.core.mount(plugin);
  await f.provideThemes();
  await f.prepareUi();
  return plugin;
}
function renderSettings(f, service) {
  const { ThemeSettingsPage } = f.loadModule("plugins/settings/ThemeSettingsPage.tsx");
  return f.renderToStaticMarkup(f.React.createElement(ThemeSettingsPage, { service, active: false, onBack() {} }));
}

test("settings page renders from an injected ThemeService without a ThemeProvider", () => {
  const f = fixture();
  const dark = { id: "replacement-dark", name: "替代服务主题", type: "dark", cssVariables: {} };
  const light = { id: "replacement-light", name: "替代浅色", type: "light", cssVariables: {} };
  const service = {
    snapshot: {
      preference: { mode: "fixed", themeId: dark.id },
      theme: dark,
      themes: [light, dark],
      fallbackThemeIds: { light: light.id, dark: dark.id },
      unavailableThemeId: null,
      persistenceError: null,
      windowError: null,
    },
    snapshotReads: 0,
    getSnapshot() {
      assert.equal(this, service);
      this.snapshotReads += 1;
      return this.snapshot;
    },
    subscribe() { return () => {}; },
    setPreference() {},
    retry() {},
  };

  const markup = renderSettings(f, service);
  assert.match(markup, /替代服务主题/);
  assert.ok(service.snapshotReads > 0);
});

test("manager opens one registration API before contributions and delays application until UI preparation", async () => {
  const nativeReady = deferred();
  const selected = definition("example.custom.day", "light", { "surface.content": "#EEEECC" });
  const f = fixture({ preference: fixed(selected.id), nativeSetGate: nativeReady.promise });
  await f.provideUi();
  await f.core.mount(f.createThemePlugin());
  const service = f.core.get(f.themeKey);
  assert.equal(service.getSnapshot().theme, null);
  assert.equal(service.getSnapshot().themes.length, 0);
  await f.provideThemes();
  await f.provideThemes([selected]);
  assert.equal(service.getSnapshot().themes.length, 3);
  assert.equal(service.getSnapshot().theme, null);
  assert.deepEqual(f.root.dataset, {});
  assert.equal(f.nativeCalls.length, 0);
  assert.equal(f.channels.length, 0);
  let ready = false;
  const preparing = f.prepareUi().then(() => { ready = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ready, false);
  assert.equal(f.root.dataset.uiThemeId, selected.id);
  assert.deepEqual(f.nativeCalls, ["light"]);
  nativeReady.resolve();
  await preparing;
  await f.core.unmountAll();
});

test("the dependency graph activates the manager before all theme contributors, regardless of input order", async () => {
  const f = fixture();
  await f.provideUi();
  const builtin = f.createBuiltinThemesPlugin();
  const theme = f.createThemePlugin();
  assert.equal(builtin.requires[0], f.themeKey);
  assert.equal(builtin.provides.length, 0);
  assert.equal(theme.requires.length, 1);
  await f.core.mountAll([builtin, theme]);
  assert.equal(f.core.get(f.themeKey).getSnapshot().themes.length, 2);
  await f.prepareUi();
  await f.core.unmount("builtin-themes");
  assert.equal(f.core.get(f.themeKey).getSnapshot().themes.length, 0);
  assert.equal(f.core.get(f.themeKey).getSnapshot().theme, null);
  await f.core.unmountAll();
});

test("selection, notifications, persistence retry and remount preserve saved intent with fresh registrations", async () => {
  const f = fixture();
  const plugin = await mount(f);
  const service = f.core.get(f.themeKey);
  let notifications = 0;
  const unsubscribe = service.subscribe(() => { notifications++; });
  service.setPreference(fixed(lightId));
  assert.equal(service.getSnapshot().theme.type, "light");
  assert.equal(notifications, 1);
  unsubscribe();
  f.controls.writeError = true;
  service.setPreference(fixed(darkId));
  assert.equal(notifications, 1);
  assert.equal(service.getSnapshot().persistenceError, true);
  f.controls.writeError = false;
  service.retry();
  assert.equal(service.getSnapshot().persistenceError, false);
  assert.deepEqual(JSON.parse(f.values.get("lodestory.theme-preference")), fixed(darkId));
  await f.core.unmount("builtin-themes");
  await f.core.unmount("theme");
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.windowListenerCount("storage"), 0);
  assert.equal(f.channels[0].closed, true);
  assert.equal(f.nativeListeners.size, 0);
  plugin.deactivate();
  assert.equal(f.unlistenCalls, 1);
  await f.core.mount(plugin);
  const next = f.core.get(f.themeKey);
  assert.notEqual(next, service);
  assert.equal(next.getSnapshot().themes.length, 0);
  await f.provideThemes();
  await f.prepareUi();
  assert.equal(next.getSnapshot().theme.id, darkId);
  assert.equal(f.mediaListeners.size, 1);
  await f.core.unmountAll();
  assert.equal(f.channels[1].closed, true);
  assert.equal(f.unlistenCalls, 2);
});

test("capability conflicts remove the staged wrapper without starting any platform resource", async () => {
  const f = fixture();
  await f.provideUi();
  await f.core.mount({ id: "existing-theme", requires: [], provides: [f.themeKey], activate(context) { context.provide(f.themeKey, {}); } });
  await assert.rejects(f.core.mount(f.createThemePlugin()), /already registered/);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.channels.length, 0);
  assert.deepEqual(f.root.dataset, {});
  assert.equal(f.uiRegistrations.at(-1).active, false);
  assert.deepEqual(f.uiLifecycle.slice(-2), ["remove:theme", "stop-theme-sync"]);
  await f.core.unmountAll();
});

test("native listener completing after deactivation is immediately removed", async () => {
  const gate = deferred();
  const f = fixture({ nativeListenerGate: gate.promise });
  await mount(f);
  await f.core.unmountAll();
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.nativeListeners.size, 0);
  assert.equal(f.unlistenCalls, 1);
});

test("native synchronization errors remain recoverable without blocking UI preparation", async () => {
  const f = fixture({ nativeSetError: true });
  await mount(f);
  assert.equal(f.core.get(f.themeKey).getSnapshot().windowError, true);
  await f.core.unmountAll();
});

test("ThemeProvider receives the registered service and wrapper removal precedes platform cleanup", async () => {
  const f = fixture();
  await mount(f);
  const service = f.core.get(f.themeKey);
  const { wrapper } = f.uiRegistrations.find(item => item.wrapper.id === "theme");
  function Probe() { return f.React.createElement("span", { "data-same-service": String(f.useThemeService() === service) }); }
  assert.match(f.renderToStaticMarkup(wrapper.wrap(f.React.createElement(Probe))), /data-same-service="true"/);
  await f.core.unmount("builtin-themes");
  f.controls.uiDisposeError = true;
  await assert.rejects(f.core.unmount("theme"), /UI wrapper disposer failed/);
  assert.deepEqual(f.uiLifecycle.slice(-2), ["remove:theme", "stop-theme-sync"]);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.channels[0].closed, true);
  assert.throws(() => f.core.get(f.themeKey), /not registered/);
  f.controls.uiDisposeError = false;
  await f.core.unmountAll();
});

test("settings previews and fallback choices follow registered themes, including after builtins are unloaded", async () => {
  const f = fixture();
  await mount(f);
  const service = f.core.get(f.themeKey);
  const custom = definition(undefined, "dark", { "surface.content": "#171A23" });
  const remove = service.registerTheme(custom);
  service.setPreference(fixed(custom.id));
  assert.match(renderSettings(f, service), /checked="" value="example.custom.ink"/);
  assert.match(renderSettings(f, service), /--ui-surface-workspace:#171A23/);
  service.setPreference(fixed(darkId));
  await f.core.unmount("builtin-themes");
  assert.equal(service.getSnapshot().theme.id, custom.id);
  assert.equal(service.getSnapshot().unavailableThemeId, darkId);
  assert.doesNotMatch(renderSettings(f, service), /value="lodestory\.builtin/);
  assert.match(renderSettings(f, service), /需要已启用的深色和浅色主题/);
  remove();
  assert.equal(service.getSnapshot().theme, null);
  assert.equal(f.root.dataset.uiThemeId, undefined);
  assert.equal(f.root.style["--ui-surface-workspace"], undefined);
  assert.match(renderSettings(f, service), /暂无可用主题/);
  await f.provideThemes();
  assert.equal(service.getSnapshot().theme.id, darkId);
  assert.equal(service.getSnapshot().unavailableThemeId, null);
  await f.core.unmountAll();
});

test("default and fallback IDs can name custom themes registered through the ordinary API", async () => {
  const f = fixture({ saved: "system", system: "light" });
  const dark = definition("example.defaults.ink");
  const light = definition("example.defaults.paper", "light", { "surface.content": "#DDEEFF" });
  const config = { defaultThemeId: light.id, fallbackThemeIds: { dark: dark.id, light: light.id } };
  await f.provideUi();
  await f.core.mount(f.createThemePlugin(config));
  await f.provideThemes([dark, light]);
  await f.prepareUi();
  const service = f.core.get(f.themeKey);
  assert.equal(service.getSnapshot().theme.id, light.id);
  assert.equal(service.getSnapshot().preference.lightThemeId, light.id);
  assert.equal(Object.isFrozen(service.getSnapshot().fallbackThemeIds), true);
  assert.match(renderSettings(f, service), /--ui-surface-workspace:#DDEEFF/);
  assert.doesNotMatch(renderSettings(f, service), /lodestory\.builtin/);
  const stop = service.registerTheme(definition("example.custom.paper", "light"));
  service.setPreference(fixed("example.custom.paper"));
  stop();
  assert.equal(service.getSnapshot().theme.id, light.id);
  await f.core.unmountAll();
});

test("missing or wrongly typed configured IDs fail preparation before platform resources are started", async () => {
  for (const scenario of ["empty", "default", "type"]) {
    const f = fixture();
    await f.provideUi();
    const config = scenario === "default" ? { ...f.config, defaultThemeId: "example.missing.theme" } : f.config;
    await f.core.mount(f.createThemePlugin(config));
    if (scenario === "default") await f.provideThemes();
    if (scenario === "type") await f.provideThemes([definition(darkId), definition(lightId)]);
    await assert.rejects(f.prepareUi(), scenario === "type" ? /Missing light fallback/ : /Default theme.*not registered/);
    assert.deepEqual(f.root.dataset, {});
    assert.equal(f.channels.length, 0);
    assert.equal(f.nativeCalls.length, 0);
    await f.core.unmountAll();
  }
});

test("builtin activation failure revokes earlier registrations without deleting the conflicting contributor", async () => {
  const f = fixture();
  await f.provideUi();
  await f.core.mount(f.createThemePlugin());
  const service = f.core.get(f.themeKey);
  service.registerTheme(definition(lightId, "light"));
  await assert.rejects(f.core.mount(f.createBuiltinThemesPlugin()), /already registered/);
  assert.deepEqual(Array.from(service.getSnapshot().themes, theme => theme.id), [lightId]);
  assert.equal(f.core.isMounted("builtin-themes"), false);
  assert.deepEqual(f.root.dataset, {});
  await f.core.unmountAll();
});

test("old disposers and delayed native requests cannot repaint a remounted manager", async () => {
  const f = fixture();
  const plugin = await mount(f);
  const oldService = f.core.get(f.themeKey);
  const custom = definition();
  const removeOld = oldService.registerTheme(custom);
  const gate = deferred();
  f.controls.nativeDelay = gate.promise;
  oldService.setPreference(fixed(lightId));
  await Promise.resolve();
  oldService.setPreference(fixed(custom.id));
  await f.core.unmount("builtin-themes");
  await f.core.unmount("theme");
  await f.core.mount(plugin);
  await f.provideThemes();
  const preparing = f.prepareUi();
  gate.resolve();
  await preparing;
  const service = f.core.get(f.themeKey);
  assert.equal(service.getSnapshot().unavailableThemeId, custom.id);
  assert.equal(f.nativeTheme(), "dark");
  service.registerTheme(custom);
  removeOld();
  assert.equal(service.getSnapshot().theme.id, custom.id);
  assert.equal(f.root.dataset.uiThemeId, custom.id);
  assert.equal(f.mediaListeners.size, 1);
  await f.core.unmountAll();
});

test("the configured initial default can be light while the dark fallback stays independently configured", async () => {
  const f = fixture();
  await f.provideUi();
  await f.core.mount(f.createThemePlugin({ ...f.config, defaultThemeId: lightId }));
  await f.provideThemes();
  await f.prepareUi();
  const service = f.core.get(f.themeKey);
  assert.equal(service.getSnapshot().preference.themeId, lightId);
  assert.equal(service.getSnapshot().theme.id, lightId);
  assert.equal(service.getSnapshot().fallbackThemeIds.dark, darkId);
  await f.core.unmountAll();
});
