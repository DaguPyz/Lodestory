import assert from "node:assert/strict";
import test from "node:test";
import {createI18nFixture} from "./helpers/i18nFixture.mjs";
import {createMainFixture, deferred} from "./helpers/mainStartupFixture.mjs";

test("language snapshots translate exact source text and fall back to it after withdrawal", async t => {
  const fixture = createMainFixture();
  const {i18n, stop} = createI18nFixture(fixture.loadModule);
  t.after(stop);
  const messages = {
    en: {"打开 {name}": "Open {name}"},
  };
  const remove = i18n.registerMessages("example", messages);
  const initial = i18n.getSnapshot();
  assert.strictEqual(i18n.getSnapshot(), initial);
  assert.throws(() => i18n.registerMessages("example", messages), /already registered/);
  assert.throws(() => i18n.registerMessages("invalid", {en: {"打开": ""}}), /Invalid translation/);
  assert.strictEqual(i18n.getSnapshot(), initial);
  messages.en["打开 {name}"] = "Modified by caller";

  await i18n.setLocale("en");
  const english = i18n.getSnapshot();
  const options = {values: {name: "故事 {name}"}};
  assert.equal(english.t("打开 {name}", options), "Open 故事 {name}");
  assert.equal(english.t("关闭"), "关闭");
  assert.equal(initial.t("打开 {name}", options), "打开 故事 {name}");
  assert.equal(fixture.documentRoot.getAttribute("lang"), "en");
  remove();
  remove();
  assert.equal(i18n.getSnapshot().t("打开 {name}", options), "打开 故事 {name}");
  assert.equal(english.t("打开 {name}", options), "Open 故事 {name}");
});

test("shared source text can use a plugin's translation without depending on registration order", async t => {
  const fixture = createMainFixture();
  const {i18n, stop} = createI18nFixture(fixture.loadModule, {userValues: {"i18n.locale": "en"}});
  t.after(stop);
  i18n.registerMessages("welcome", {en: {"搜索项目": "Search projects", "设置": "Settings"}});
  const remove = i18n.registerMessages("toolbar", {en: {"搜索项目": "Search project", "设置": "Settings"}});
  const {t: translate} = i18n.getSnapshot();
  assert.equal(translate("设置"), "Settings");
  assert.equal(translate("搜索项目"), "搜索项目");
  assert.equal(translate("搜索项目", {namespace: "toolbar"}), "Search project");
  assert.equal(translate("搜索项目", {namespace: "welcome"}), "Search projects");
  remove();
  assert.equal(i18n.getSnapshot().t("搜索项目"), "Search projects");
});

test("language writes apply after persistence, can be retried and finish before cleanup", async () => {
  const fixture = createMainFixture();
  fixture.documentRoot.setAttribute("lang", "zh-CN");
  const gate = deferred();
  let fail = true;
  let current;
  const {i18n, stop} = createI18nFixture(fixture.loadModule, {
    async persist(values) {
      if (fail) throw new Error("Storage unavailable");
      await gate.promise;
      current = values["i18n.locale"];
    },
  });

  const rejected = i18n.setLocale("en");
  assert.equal(i18n.getSnapshot().pendingLocale, "en");
  await assert.rejects(rejected, /Storage unavailable/);
  assert.equal(i18n.getSnapshot().failedLocale, "en");
  assert.equal(i18n.getSnapshot().locale, "zh-CN");
  assert.equal(fixture.documentRoot.getAttribute("lang"), "zh-CN");
  assert.equal(current, undefined);
  await assert.rejects(i18n.setLocale("fr"), /Unsupported interface language/);

  fail = false;
  const retry = i18n.setLocale(i18n.getSnapshot().failedLocale);
  assert.equal(i18n.getSnapshot().locale, "zh-CN");
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  gate.resolve();
  await Promise.all([retry, stopping]);
  assert.equal(current, "en");
  assert.equal(fixture.documentRoot.getAttribute("lang"), "zh-CN");

  const restored = createI18nFixture(fixture.loadModule, {userValues: {"i18n.locale": current}});
  assert.equal(restored.i18n.getSnapshot().locale, "en");
  assert.equal(fixture.documentRoot.getAttribute("lang"), "en");
  await restored.stop();
});

test("built-in catalogs are registered and withdrawn as their plugins are enabled and disabled", async t => {
  const fixture = createMainFixture({tauri: false, configOverrides: {"i18n.locale": "en"}});
  const {createAppPlugins} = fixture.loadModule("app/appPlugins.ts");
  const {createAppRuntime} = fixture.loadModule("app/createAppRuntime.ts");
  const plugins = createAppPlugins();
  await assert.rejects(createAppRuntime(plugins.filter(plugin => plugin.id !== "i18n")), /app\/i18n/);

  const runtime = await createAppRuntime(plugins);
  t.after(() => runtime.stop());
  const {settingsKey} = fixture.requireSdk("@lodestory/sdk/settings");
  const {i18nKey} = fixture.requireSdk("@lodestory/sdk/i18n");
  const {pluginRuntimeKey} = fixture.requireSdk("@lodestory/sdk/plugin-runtime");
  const settings = runtime.get(settingsKey);
  const i18n = runtime.get(i18nKey);

  assert.equal(i18n.getSnapshot().t("快捷键", {namespace: "shortcuts"}), "Shortcuts");
  assert.equal(i18n.getSnapshot().t("界面语言"), "Interface language");
  assert.equal(settings.open("general.language"), true);
  await assert.rejects(runtime.unmount("i18n"), /required by plugins/);
  await runtime.unmount("language-settings");
  assert.equal(settings.open("general.language"), false);
  assert.equal(settings.open("appearance.theme"), true);
  assert.equal(i18n.getSnapshot().locale, "en");
  assert.equal(i18n.getSnapshot().t("界面语言"), "界面语言");
  assert.equal(i18n.getSnapshot().t("作品"), "Projects");

  await runtime.get(pluginRuntimeKey).mount(plugins.find(plugin => plugin.id === "language-settings"));
  assert.equal(settings.open("general.language"), true);
  assert.equal(i18n.getSnapshot().t("界面语言"), "Interface language");
});

test("automatic catalog cleanup follows plugin rollback and withdrawal", async t => {
  const fixture = createMainFixture({tauri: false, configOverrides: {"i18n.locale": "en"}});
  const {createAppRuntime} = fixture.loadModule("app/createAppRuntime.ts");
  const {createConfigPlugin} = fixture.loadModule("plugins/config/configPlugin.ts");
  const {createI18nPlugin} = fixture.loadModule("plugins/i18n/i18nPlugin.ts");
  const {withPluginCatalog} = fixture.loadModule("plugins/i18n/withPluginCatalog.ts");
  const {i18nKey} = fixture.requireSdk("@lodestory/sdk/i18n");
  const {pluginRuntimeKey} = fixture.requireSdk("@lodestory/sdk/plugin-runtime");
  const runtime = await createAppRuntime([createConfigPlugin(), createI18nPlugin()]);
  const i18n = runtime.get(i18nKey);
  const plugins = runtime.get(pluginRuntimeKey);
  const translate = () => i18n.getSnapshot().t("测试词条");
  let activationFails = true;
  let stopBlocked = false;
  let cleanups = 0;
  t.after(() => { stopBlocked = false; return runtime.stop(); });

  const plugin = {
    id: "catalog-probe", requires: [], provides: [],
    async activate(context) {
      assert.equal(translate(), "Probe");
      context.onStop({
        check() { if (stopBlocked) throw new Error("Probe is busy"); },
        withdraw() { assert.equal(translate(), "Probe"); },
      });
      if (activationFails) throw new Error("Probe activation failed");
    },
    deactivate() {
      assert.equal(translate(), "Probe");
      cleanups++;
    },
  };
  assert.strictEqual(withPluginCatalog(plugin, undefined), plugin);
  await assert.rejects(plugins.mount(withPluginCatalog(plugin, {en: {"测试词条": ""}})), /Invalid translation/);
  assert.equal(cleanups, 0);

  const localized = withPluginCatalog(plugin, {en: {"测试词条": "Probe"}});
  assert.deepEqual(Array.from(localized.requires), [i18nKey]);
  await assert.rejects(plugins.mount(localized), /Probe activation failed/);
  assert.equal(cleanups, 1);
  assert.equal(translate(), "测试词条");

  activationFails = false;
  await plugins.mount(localized);
  stopBlocked = true;
  await assert.rejects(plugins.unmount(plugin.id), /stop check failed/);
  assert.equal(translate(), "Probe");
  stopBlocked = false;
  await plugins.unmount(plugin.id);
  assert.equal(cleanups, 2);
  assert.equal(translate(), "测试词条");
});
