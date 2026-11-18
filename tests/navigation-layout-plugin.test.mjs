import assert from "node:assert/strict";
import test from "node:test";
import { createMainFixture, flushStartup } from "./helpers/mainStartupFixture.mjs";

function uiFor(fixture) {
  return fixture.getService(fixture.requireSdk("@lodestory/sdk/ui").uiKey);
}

async function openReadyProject(workbench, target) {
  assert.equal(await workbench.openProject(target), true);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const snapshot = workbench.getSnapshot();
    if (snapshot.loading?.error) assert.fail(snapshot.loading.error.message);
    if (!snapshot.busy) return snapshot;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("workbench startup did not settle");
}

function registeredPage(fixture, ui, id) {
  const tree = fixture.UiPages({service: ui});
  const pageNode = tree.props.children.find((item) => item.key === id);
  assert.ok(pageNode, `page '${id}' should be registered`);
  const page = pageNode.props.children;
  return page.type === fixture.components.ErrorBoundary ? page.props.children : page;
}

function alternateProvider(sdk, registered, removed = []) {
  const {navigationLayoutKey} = sdk.requireSdk("@lodestory/sdk/navigation-layout");
  const {windowShellKey} = sdk.requireSdk("@lodestory/sdk/window-shell");
  const {uiKey} = sdk.requireSdk("@lodestory/sdk/ui");
  const {themeKey} = sdk.requireSdk("@lodestory/sdk/theme");
  const {pluginPackagesKey} = sdk.requireSdk("@lodestory/sdk/plugin-packages");
  const {navigationLayoutExternalCapability} = sdk.requireSdk("@lodestory/sdk/navigation-layout");
  let removeCapability;
  return {
    id: "navigation-layout",
    requires: [uiKey, themeKey, windowShellKey, pluginPackagesKey],
    provides: [navigationLayoutKey],
    activate(context) {
      const ui = context.get(uiKey);
      const View = context.get(windowShellKey).View;
      removeCapability = context.get(pluginPackagesKey).registerCapability(navigationLayoutExternalCapability);
      const service = {
        registerPages(pages) {return pages.map(page => service.registerPage(page));},
        registerPage(page) {
          registered.push({id: page.id, navigation: page.navigation});
          const remove = ui.registerPage({
            id: page.id,
            render: pageContext => ({type: View, props: {children: page.render(pageContext)}}),
          });
          const dispose = () => {
            remove();
            removed.push(page.id);
          };
          return Object.assign(dispose, {associate: owner => remove.associate(owner), check: scope => remove.check(scope),
            withdrawOrder: scope => typeof remove.withdrawOrder === "function" ? remove.withdrawOrder(scope) : (remove.withdrawOrder ?? 0),
            async withdraw(scope) {await remove.withdraw(scope); if (scope === "plugin") removed.push(page.id);}});
        },
        registerAction(action) {
          registered.push({id: action.id, navigation: action.navigation, run: action.run});
          const remove = () => { removed.push(action.id); };
          return Object.assign(remove, {associate() {}, check() {}, withdraw(scope) {if (scope === "plugin") remove();}});
        },
      };
      context.provide(navigationLayoutKey, Object.freeze(service));
    },
    deactivate() {removeCapability?.();},
  };
}

test("welcome and settings contribute a page and an action through the public layout service", async () => {
  const fixture = createMainFixture();
  fixture.start();
  await flushStartup();

  const ui = uiFor(fixture);
  const welcome = registeredPage(fixture, ui, "welcome");
  assert.equal(welcome.type, fixture.components.PageShell);
  const welcomeLayout = welcome.props.children;
  assert.equal(welcomeLayout.type, fixture.components.NavigationLayout);
  assert.deepEqual(Array.from(welcomeLayout.props.items, ({id, label, group, order}) => ({id, label, group, order})), [
    {id: "welcome", label: "作品", group: "primary", order: 0},
    {id: "settings", label: "设置", group: "secondary", order: 0},
  ]);
  assert.equal(welcomeLayout.props.pageId, "welcome");
  assert.equal(welcomeLayout.props.items.find(item => item.id === "settings").kind, "action");
  assert.equal(await welcomeLayout.props.onNavigate("settings"), true);
  assert.equal(ui.getSnapshot().current.id, "welcome", "an action does not navigate to another page");
  await fixture.createdCores.at(-1).unmountAll();
});

test("a third page adds a sorted navigation entry without changing the layout plugin", async () => {
  const extraPages = [
    {id: "example.zulu", navigation: {label: "后项", order: 4, group: "primary"}},
    {id: "example.alpha", navigation: {label: "前项", order: 2, group: "primary"}},
    {id: "example.beta", navigation: {label: "并列项", order: 2, group: "primary"}},
    {id: "example.secondary", navigation: {label: "辅助", order: 1, group: "secondary"}},
  ];
  const fixture = createMainFixture({
    additionalPlugins: ({requireSdk}) => {
      const {navigationLayoutKey} = requireSdk("@lodestory/sdk/navigation-layout");
      const removers = [];
      return [{
        id: "example.third-pages",
        requires: [navigationLayoutKey],
        provides: [],
        activate(context) {
          const layout = context.get(navigationLayoutKey);
          for (const page of extraPages) removers.push(layout.registerPage({...page, render: () => null}));
        },
        deactivate() { for (const remove of removers.splice(0).reverse()) remove(); },
      }];
    },
  });
  fixture.start();
  await flushStartup();

  const shell = registeredPage(fixture, uiFor(fixture), "welcome");
  assert.equal(shell.type, fixture.components.PageShell);
  const navigation = shell.props.children;
  assert.equal(navigation.type, fixture.components.NavigationLayout);
  assert.deepEqual(Array.from(navigation.props.items, ({id}) => id), [
    "welcome", "example.alpha", "example.beta", "example.zulu", "settings", "example.secondary",
  ]);
  assert.equal(fixture.moduleImports.some(({from}) => from === "plugins/navigation-layout/navigationLayoutPlugin.tsx"), true);
  await fixture.createdCores.at(-1).unmountAll();
});

test("the built-in navigation layout can be replaced while page plugins keep the same contract", async () => {
  const registered = [];
  const fixture = createMainFixture({navigationLayoutFactory: (sdk) => alternateProvider(sdk, registered)});
  fixture.start();
  await flushStartup();

  assert.deepEqual(registered.map(({id}) => id).sort(), ["settings", "welcome"]);
  const welcomeRegistration = registered.find(({id}) => id === "welcome");
  assert.equal(welcomeRegistration.navigation.label, "作品");
  assert.equal(welcomeRegistration.navigation.group, "primary");
  assert.equal(welcomeRegistration.navigation.order, 0);
  assert.equal(welcomeRegistration.navigation.icon.type.name, "Icon");
  assert.equal(welcomeRegistration.navigation.icon.props.name, "folder");
  const page = registeredPage(fixture, uiFor(fixture), "welcome");
  assert.equal(page.type, fixture.components.PageShell);
  assert.equal(page.props.children.type, fixture.components.ErrorBoundary);
  const welcomePage = page.props.children.props.children;
  assert.equal(welcomePage.type, fixture.components.WelcomePage);
  assert.equal(typeof welcomePage.props.onOpenProject, "function");
  assert.equal(fixture.catalogPluginIds.includes("navigation-layout"), true);
  await fixture.createdCores.at(-1).unmountAll();
});

test("missing navigation layout stops page activation during startup", async () => {
  const fixture = createMainFixture({omitNavigationLayout: true});
  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 0);
  assert.equal(fixture.rootElement.children[0]?.className, "app-startup-error");
  const core = fixture.createdCores.at(-1);
  assert.equal(core.isMounted("navigation-layout"), false);
  assert.equal(core.isMounted("welcome"), false);
  assert.equal(core.isMounted("settings"), false);
});

test("a page registered by a failed plugin activation is removed during startup rollback", async () => {
  const registered = [];
  const removed = [];
  let removePartialPage;
  const activationError = new Error("page activation failed after registration");
  const fixture = createMainFixture({
    navigationLayoutFactory: (sdk) => alternateProvider(sdk, registered, removed),
    additionalPlugins: ({requireSdk}) => {
      const {navigationLayoutKey} = requireSdk("@lodestory/sdk/navigation-layout");
      return [{
        id: "example.partial-page",
        requires: [navigationLayoutKey],
        provides: [],
        activate(context) {
          removePartialPage = context.get(navigationLayoutKey).registerPage({
            id: "example.partial",
            navigation: {label: "部分页面"},
            render: () => null,
          });
          throw activationError;
        },
        deactivate() { removePartialPage?.(); },
      }];
    },
  });
  fixture.start();
  await flushStartup();

  assert.equal(fixture.rootCalls.length, 0);
  assert.ok(registered.some(({id}) => id === "example.partial"));
  assert.ok(removed.includes("example.partial"), "failed plugin cleanup must revoke the page it already registered");
  assert.ok(fixture.lifecycle.includes("deactivate:example.partial-page:complete"));
  assert.equal(fixture.createdCores.at(-1).isMounted("navigation-layout"), false);
  assert.equal(fixture.createdCores.at(-1).isMounted("example.partial-page"), false);
});

test("navigation validates registrations and allows runtime actions", async () => {
  const fixture = createMainFixture();
  const {createNavigationLayoutPlugin} = fixture.loadModule("plugins/navigation-layout/navigationLayoutPlugin.tsx");
  const {navigationLayoutKey} = fixture.requireSdk("@lodestory/sdk/navigation-layout");
  const {uiKey} = fixture.requireSdk("@lodestory/sdk/ui");
  const {themeKey} = fixture.requireSdk("@lodestory/sdk/theme");
  const {windowShellKey} = fixture.requireSdk("@lodestory/sdk/window-shell");
  const {pluginPackagesKey} = fixture.requireSdk("@lodestory/sdk/plugin-packages");
  const registrations = new Map();
  const actionMarkers = new Map();
  const removals = [];
  let ready = false;
  const ui = {
    registerPage(page) {
      if (ready) throw new Error("UI pages can only be registered before pluginsReady.");
      if (registrations.has(page.id)) throw new Error(`Page '${page.id}' is already registered.`);
      registrations.set(page.id, page);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        removals.push(page.id);
        registrations.delete(page.id);
      };
    },
    addWrapper(wrapper) {
      if (ready) throw new Error("UI wrappers can only be registered before pluginsReady.");
      actionMarkers.set(wrapper.id, wrapper);
      return () => { actionMarkers.delete(wrapper.id); };
    },
    openPage(id) { return Promise.resolve(id); },
  };
  const services = new Map();
  const plugin = createNavigationLayoutPlugin();
  const FakeWindowShell = function FakeWindowShell() {};
  plugin.activate({
    get(key) {
      if (key === uiKey) return ui;
      if (key === themeKey) return {};
      if (key === windowShellKey) return Object.freeze({View: FakeWindowShell});
      if (key === pluginPackagesKey) return {registerCapability() {return () => {};}};
      if (key.id === "app/i18n") return {registerMessages: () => () => {}};
      throw new Error(`Unexpected dependency '${key.id}'.`);
    },
    provide(key, value) { services.set(key, value); },
  });
  const service = services.get(navigationLayoutKey);
  const validPage = (id, order, group = "primary") => ({
    id,
    navigation: {label: id, order, group},
    render: ({active}) => fixture.React.createElement("page-content", {id, active}),
  });

  for (const page of [
    {...validPage("empty-label", 0), navigation: {label: " "}},
    {...validPage("invalid-group", 0), navigation: {label: "bad", group: "tertiary"}},
    {...validPage("invalid-order", 0), navigation: {label: "bad", order: Number.NaN}},
    {...validPage("missing-render", 0), render: undefined},
  ]) {
    assert.throws(() => service.registerPage(page));
    assert.equal(registrations.size, 0, "invalid metadata must not partially register a UI page");
  }

  service.registerPage(validPage("zulu", 2));
  service.registerPage(validPage("alpha", 2));
  service.registerPage(validPage("welcome", 0));
  service.registerPage(validPage("settings", 0, "secondary"));
  assert.throws(() => service.registerPage(validPage("alpha", 99)), /already registered/);
  assert.equal(registrations.size, 4);
  const alpha = registrations.get("alpha");
  const rendered = alpha.render({active: true, params: undefined});
  assert.equal(rendered.type, FakeWindowShell);
  const navigationLayout = rendered.props.children;
  assert.equal(navigationLayout.type, fixture.components.NavigationLayout);
  assert.deepEqual(Array.from(navigationLayout.props.items, ({id}) => id), ["welcome", "alpha", "zulu", "settings"]);
  assert.equal(navigationLayout.props.children.type, "page-content");
  assert.equal(await navigationLayout.props.onNavigate("settings"), "settings");
  let batchChanges = 0;
  const unsubscribeBatch = navigationLayout.props.subscribeItems(() => {batchChanges++;});
  assert.throws(() => service.registerPages([validPage("new-batch", 0), validPage("alpha", 0)]), /already registered/);
  assert.equal(batchChanges, 0);
  assert.equal(registrations.has("new-batch"), false);
  registrations.set("blocked-batch", {});
  assert.throws(() => service.registerPages([validPage("new-batch", 0), validPage("blocked-batch", 0)]), /already registered/);
  assert.equal(batchChanges, 0);
  assert.equal(registrations.has("new-batch"), false);
  assert.equal(removals.pop(), "new-batch");
  registrations.delete("blocked-batch");
  const batch = service.registerPages([validPage("batch-a", 0), validPage("batch-b", 0)]);
  assert.equal(batchChanges, 1);
  unsubscribeBatch();
  batch.forEach(remove => remove());
  removals.splice(removals.indexOf("batch-a"), 1);
  removals.splice(removals.indexOf("batch-b"), 1);

  let actions = 0;
  assert.throws(() => service.registerAction({id: "bad", navigation: {label: "bad"}, run: null}));
  assert.equal(actionMarkers.size, 0);
  const removeAction = service.registerAction({id: "action", navigation: {label: "操作", group: "secondary"}, run: () => { actions++; }});
  assert.throws(() => service.registerAction({id: "alpha", navigation: {label: "重复"}, run() {}}), /already registered/);
  assert.throws(() => service.registerPage(validPage("action", 0)), /already registered/);
  const withAction = registrations.get("alpha").render({active: true}).props.children;
  assert.equal(withAction.props.items.find(item => item.id === "action").kind, "action");
  assert.equal(await withAction.props.onNavigate("action"), true);
  assert.equal(actions, 1);
  removeAction();
  removeAction();
  assert.equal(actionMarkers.size, 0);
  assert.equal(await withAction.props.onNavigate("action"), false);

  const originalIcon = {name: "folder"};
  const navigation = {label: "原始名称", icon: originalIcon, order: 3, group: "primary"};
  const params = {session: "session-1"};
  const replaceablePage = {
    id: "replaceable",
    navigation,
    render: context => fixture.React.createElement("page-content", {
      params: context.params,
      active: context.active,
    }),
  };
  const removeOld = service.registerPage(replaceablePage);
  navigation.label = "已修改";
  navigation.icon = {name: "settings"};
  navigation.order = 0;
  navigation.group = "secondary";
  const oldPageElement = registrations.get("replaceable").render({params, active: false});
  const oldNavigationLayout = oldPageElement.props.children;
  assert.equal(oldNavigationLayout.props.active, false);
  const registeredItem = oldNavigationLayout.props.items.find(({id}) => id === "replaceable");
  assert.equal(registeredItem.label, "原始名称");
  assert.strictEqual(registeredItem.icon, originalIcon);
  assert.equal(registeredItem.group, "primary");
  assert.equal(registeredItem.order, 3);
  assert.strictEqual(oldNavigationLayout.props.children.props.params, params);
  assert.equal(oldNavigationLayout.props.children.props.active, false);
  removeOld();
  removeOld();
  assert.equal(registrations.has("replaceable"), false, "a disposer is idempotent");

  const removeFresh = service.registerPage({
    ...validPage("replaceable", 1),
    navigation: {label: "新登记", order: 1},
  });
  removeOld();
  assert.equal(registrations.has("replaceable"), true, "an old disposer cannot revoke a later registration with the same ID");
  assert.equal(registrations.get("replaceable").render({params, active: true}).props.children.props.items.find(({id}) => id === "replaceable").label, "新登记");
  removeFresh();
  removeFresh();
  assert.equal(registrations.has("replaceable"), false);

  ready = true;
  const lateSnapshot = [...registrations.keys()];
  assert.throws(() => service.registerPage(validPage("late", 0)), /pluginsReady/);
  let changes = 0;
  const unsubscribe = navigationLayout.props.subscribeItems(() => { changes++; });
  const removeLate = service.registerAction({id: "late-action", navigation: {label: "新增"}, run() {}});
  assert.ok(navigationLayout.props.getItems().some(item => item.id === "late-action"));
  removeLate();
  assert.ok(!navigationLayout.props.getItems().some(item => item.id === "late-action"));
  assert.equal(changes, 2);
  unsubscribe();
  assert.deepEqual([...registrations.keys()], lateSnapshot, "a rejected late registration leaves no UI or navigation entry");

  plugin.deactivate();
  assert.deepEqual(removals, ["replaceable", "replaceable", "settings", "welcome", "alpha", "zulu"]);
  assert.equal(registrations.size, 0);
  assert.throws(() => service.registerPage(validPage("after-stop", 0)), /no longer active/);
  plugin.deactivate();
  assert.deepEqual(removals, ["replaceable", "replaceable", "settings", "welcome", "alpha", "zulu"], "cleanup is safe to repeat");
});

test("a navigation guard rejection preserves the active project and route", async () => {
  const project = {id: "novel", name: "一本小说", path: "/stories/novel"};
  const fixture = createMainFixture({
    additionalPlugins: ({requireSdk}) => {
      const {uiKey} = requireSdk("@lodestory/sdk/ui");
      return [{
        id: "example.navigation-guard",
        requires: [uiKey],
        provides: [],
        activate(context) {
          context.get(uiKey).registerNavigationGuard({
            id: "example.deny-welcome-from-editor",
            prepare: ({from, to}) => !(from?.id === "editor" && to.id === "welcome"),
          });
        },
      }];
    },
  });
  fixture.start();
  await flushStartup();

  const ui = uiFor(fixture);
  const workbench = fixture.getService(fixture.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  const opened = await openReadyProject(workbench, project);
  const sessionId = opened.session.id;
  assert.equal(await ui.openPage("welcome"), false);
  assert.equal(ui.getSnapshot().current.id, "editor");
  assert.equal(workbench.getSnapshot().session.id, sessionId);
  assert.equal(workbench.getSnapshot().session.project.path, project.path);
  await fixture.createdCores.at(-1).unmountAll();
});

