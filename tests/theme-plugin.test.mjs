import assert from "node:assert/strict";
import test from "node:test";
import { deferred, fixture } from "./helpers/themeFixture.mjs";

test("theme capability stays unavailable until native initialization finishes", async () => {
  const nativeReady = deferred();
  const f = fixture({ nativeSetGate: nativeReady.promise });
  const plugin = f.createThemePlugin();
  const mounting = f.core.mount(plugin);
  await Promise.resolve();
  await Promise.resolve();
  assert.throws(() => f.core.get(f.themeKey), /not registered/);
  nativeReady.resolve();
  await mounting;
  assert.equal(typeof f.core.get(f.themeKey).getSnapshot, "function");
  await f.core.unmount("theme");
});

test("registered theme service switches, notifies, cancels, retries, and unmounts cleanly", async () => {
  const f = fixture();
  const plugin = f.createThemePlugin();
  await f.core.mount(plugin);
  const service = f.core.get(f.themeKey);
  let notifications = 0;
  const unsubscribe = service.subscribe(() => { notifications += 1; });

  service.setMode("light");
  assert.equal(service.getSnapshot().mode, "light");
  assert.equal(service.getSnapshot().resolvedTheme, "light");
  assert.equal(notifications, 1);
  unsubscribe();
  service.setMode("dark");
  assert.equal(notifications, 1);

  f.controls.writeError = true;
  service.setMode("light");
  assert.equal(service.getSnapshot().persistenceError, true);
  f.controls.writeError = false;
  service.retry();
  await Promise.resolve();
  assert.equal(service.getSnapshot().persistenceError, false);
  assert.equal(f.values.get("lodestory.theme-mode"), "light");

  await f.core.unmount("theme");
  assert.throws(() => f.core.get(f.themeKey), /not registered/);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.windowListenerCount("storage"), 0);
  assert.equal(f.channels[0].closed, true);
  assert.equal(f.nativeListeners.size, 0);
  plugin.deactivate();
  assert.equal(f.unlistenCalls, 1);

  await f.core.mount(plugin);
  assert.equal(f.core.get(f.themeKey).getSnapshot().mode, "light");
  assert.equal(f.mediaListeners.size, 1);
  await f.core.unmount("theme");
  assert.equal(f.channels[1].closed, true);
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.nativeListeners.size, 0);
  assert.equal(f.unlistenCalls, 2);
});

test("capability commit conflict fails activation and cleans theme platform resources", async () => {
  const f = fixture();
  const conflictingProvider = {
    id: "existing-theme",
    requires: [],
    provides: [f.themeKey],
    activate(context) {
      context.provide(f.themeKey, {
        getSnapshot() {}, subscribe() {}, setMode() {}, retry() {},
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
  await f.core.unmount("existing-theme");
});

test("native listener resolving after unmount is immediately removed", async () => {
  const nativeRegistration = deferred();
  const f = fixture({ nativeListenerGate: nativeRegistration.promise });
  await f.core.mount(f.createThemePlugin());
  assert.equal(f.nativeListeners.size, 0);
  await f.core.unmount("theme");

  nativeRegistration.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.nativeListeners.size, 0);
  assert.equal(f.unlistenCalls, 1);
});

test("native setTheme failure is retained in the snapshot without failing plugin mount", async () => {
  const f = fixture({ nativeSetError: true });
  await f.core.mount(f.createThemePlugin());
  assert.equal(f.core.isMounted("theme"), true);
  assert.equal(f.core.get(f.themeKey).getSnapshot().windowError, true);
  await f.core.unmount("theme");
});
