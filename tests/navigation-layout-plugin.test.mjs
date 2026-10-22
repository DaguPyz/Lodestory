import assert from "node:assert/strict";
import test from "node:test";
import { createMainFixture, flushStartup } from "./helpers/mainStartupFixture.mjs";

function uiFor(fixture) {
  return fixture.getService(fixture.requireSdk("@lodestory/sdk/ui").uiKey);
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
  return {
    id: "navigation-layout",
    requires: [uiKey, themeKey, windowShellKey],
    provides: [navigationLayoutKey],
    activate(context) {
      const ui = context.get(uiKey);
      const View = context.get(windowShellKey).View;
      context.provide(navigationLayoutKey, Object.freeze({
        registerPage(page) {
          registered.push({id: page.id, navigation: page.navigation});
          const remove = ui.registerPage({
            id: page.id,
            render: pageContext => ({type: View, props: {children: page.render(pageContext)}}),
          });
          return () => {
            remove();
            removed.push(page.id);
          };
        },
      }));
    },
    deactivate() {},
  };
}

test("welcome and settings contribute navigation metadata through the public layout service", async () => {
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
  assert.equal(await uiFor(fixture).openPage("settings"), true);
  const settings = registeredPage(fixture, ui, "settings");
  assert.equal(settings.type, fixture.components.PageShell);
  assert.equal(settings.props.children.type, fixture.components.NavigationLayout);
  assert.equal(settings.props.children.props.pageId, "settings");
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

test("navigation registration validates atomically, rejects duplicate and late entries, and cleans up pages", async () => {
  const fixture = createMainFixture();
  const {createNavigationLayoutPlugin} = fixture.loadModule("plugins/navigation-layout/navigationLayoutPlugin.tsx");
  const {navigationLayoutKey} = fixture.requireSdk("@lodestory/sdk/navigation-layout");
  const {uiKey} = fixture.requireSdk("@lodestory/sdk/ui");
  const {themeKey} = fixture.requireSdk("@lodestory/sdk/theme");
  const {windowShellKey} = fixture.requireSdk("@lodestory/sdk/window-shell");
  const registrations = new Map();
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
            id: "example.deny-welcome-from-settings",
            prepare: ({from, to}) => !(from?.id === "settings" && to.id === "welcome"),
          });
        },
      }];
    },
  });
  fixture.start();
  await flushStartup();

  const ui = uiFor(fixture);
  const workbench = fixture.getService(fixture.requireSdk("@lodestory/sdk/workbench").workbenchKey);
  assert.equal(await workbench.openProject(project), true);
  const sessionId = workbench.getSnapshot().session.id;
  assert.equal(await ui.openPage("settings"), true);

  const settings = registeredPage(fixture, ui, "settings");
  assert.equal(await settings.props.children.props.onNavigate("welcome"), false);
  assert.equal(ui.getSnapshot().current.id, "settings");
  assert.equal(workbench.getSnapshot().session.id, sessionId);
  assert.equal(workbench.getSnapshot().session.project.path, project.path);
  await fixture.createdCores.at(-1).unmountAll();
});

