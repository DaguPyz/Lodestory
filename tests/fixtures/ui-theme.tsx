import { createElement, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "@lodestory/sdk";
import { uiKey, type UiService, type UiWrapper } from "@lodestory/sdk/ui";
import { themeKey, type ThemeDefinition, type ThemeService } from "@lodestory/sdk/theme";
import { Button, Icon, IconButton, SearchField } from "@lodestory/ui";
import "@lodestory/ui/styles.css";
import "../../src/styles/tokens.css";
import "./ui-theme.css";
import { EngineCore } from "../../src/plugin-core";
import { createBuiltinThemesPlugin } from "../../src/plugins/builtin-themes/builtinThemesPlugin";
import { createThemePlugin } from "../../src/plugins/theme/themePlugin";

const themeConfig = {
  defaultThemeId: "lodestory.builtin.dark",
  fallbackThemeIds: {
    dark: "lodestory.builtin.dark",
    light: "lodestory.builtin.light",
  },
} as const;

const customThemes: readonly ThemeDefinition[] = [
  {
    schemaVersion: 1,
    id: "lodestory.fixture.cobalt",
    name: "验收自定义 · 钴蓝",
    type: "dark",
    colors: {
      "surface.root": "#111A2A",
      "surface.content": "#17243A",
      "surface.control": "#202E47",
      "text.primary": "#E7EEFF",
      "text.secondary": "#BDC9E3",
      "text.onAction": "#FF3E9D",
      "action.background": "#365BE8",
      "action.hoverBackground": "#4A6FF5",
      "action.pressedBackground": "#2948C7",
      "action.foreground": "#B5FF4B",
      "danger.background": "#81294C",
      "danger.hoverBackground": "#A73560",
      "danger.pressedBackground": "#68203D",
      "danger.foreground": "#FFE2EF",
      "state.hoverBackground": "#423458",
      "state.hoverForeground": "#FFD5F0",
      "state.pressedBackground": "#563665",
      "state.pressedForeground": "#FFF0FA",
      "state.selectedBackground": "#2D5370",
      "state.selectedForeground": "#A9F3FF",
      "state.selectedHoverBackground": "#376A84",
      "state.selectedHoverForeground": "#D2FAFF",
      "state.selectedPressedBackground": "#20485F",
      "state.selectedPressedForeground": "#E5FCFF",
      "state.inactiveSelectedBackground": "#383849",
      "state.inactiveSelectedForeground": "#D8C8F1",
      "state.disabledBackground": "#252A36",
      "state.disabledForeground": "#70798C",
      "state.disabledSelectedBackground": "#303343",
      "state.disabledSelectedForeground": "#9691AC",
      "state.disabledBorder": "#555B70",
      "selection.background": "#FFCC4D",
      "selection.foreground": "#1B1B11",
      "caret.foreground": "#FFCC4D",
      "focus.ring": "#A7D9FF",
      "focus.inverseRing": "#FF8C42",
    },
  },
  {
    schemaVersion: 1,
    id: "lodestory.fixture.ember",
    name: "验收自定义 · 琥珀",
    type: "dark",
    colors: {
      "surface.root": "#24170F",
      "surface.content": "#332116",
      "surface.control": "#463020",
      "text.primary": "#FFF0DE",
      "text.secondary": "#E5C8A8",
      "text.onAction": "#5BE8FF",
      "action.background": "#B85219",
      "action.hoverBackground": "#D36B28",
      "action.pressedBackground": "#954011",
      "action.foreground": "#1B150D",
      "danger.background": "#9B3024",
      "danger.hoverBackground": "#B94332",
      "danger.pressedBackground": "#78251D",
      "danger.foreground": "#FFF2E6",
      "state.hoverBackground": "#60402A",
      "state.hoverForeground": "#FFE4C4",
      "state.pressedBackground": "#70472A",
      "state.pressedForeground": "#FFF0DB",
      "state.selectedBackground": "#72501F",
      "state.selectedForeground": "#FFE18A",
      "state.selectedHoverBackground": "#8A6226",
      "state.selectedHoverForeground": "#FFF0B8",
      "state.selectedPressedBackground": "#5B401A",
      "state.selectedPressedForeground": "#FFF5D8",
      "state.inactiveSelectedBackground": "#514236",
      "state.inactiveSelectedForeground": "#E9CDB0",
      "state.disabledBackground": "#392F28",
      "state.disabledForeground": "#8A7768",
      "state.disabledSelectedBackground": "#483A2E",
      "state.disabledSelectedForeground": "#B39A7D",
      "state.disabledBorder": "#6D5640",
      "selection.background": "#55E4FF",
      "selection.foreground": "#17212A",
      "caret.foreground": "#55E4FF",
      "focus.ring": "#FFD7A1",
      "focus.inverseRing": "#83F0FF",
    },
  },
];

const wrappers = new Map<string, UiWrapper>();
const uiService: UiService = {
  registerPage: () => () => {},
  addWrapper(wrapper) {
    wrappers.set(wrapper.id, wrapper);
    return () => {
      if (wrappers.get(wrapper.id) === wrapper) wrappers.delete(wrapper.id);
    };
  },
  registerNavigationGuard: () => () => {},
  openPage: async () => false,
  back: async () => true,
  getSnapshot: () => ({ current: null, pages: [], canGoBack: false }),
  subscribe: () => () => {},
};

const uiHarnessPlugin: Plugin = {
  id: "ui-theme-fixture-host",
  requires: [],
  provides: [uiKey],
  activate(context) {
    context.provide(uiKey, uiService);
  },
};

const themeRemovers: (() => void)[] = [];
const fixtureThemePlugin: Plugin = {
  id: "ui-theme-fixture-colors",
  requires: [themeKey],
  provides: [],
  deactivate() {
    for (const remove of themeRemovers.splice(0).reverse()) remove();
  },
  activate(context) {
    const service = context.get(themeKey);
    for (const theme of customThemes) themeRemovers.push(service.registerTheme(theme));
  },
};

const cssRoles = [
  "--ui-action-foreground",
  "--ui-accent-indicator",
  "--ui-text-on-action",
  "--ui-state-hover-foreground",
  "--ui-state-selected-foreground",
  "--ui-state-selected-hover-foreground",
  "--ui-state-selected-pressed-foreground",
  "--ui-state-inactive-selected-foreground",
  "--ui-state-disabled-foreground",
  "--ui-state-disabled-selected-foreground",
  "--ui-state-disabled-border",
  "--ui-caret-foreground",
  "--ui-selection-foreground",
  "--ui-text-selection-bg",
  "--ui-focus-ring",
  "--ui-focus-inverse-ring",
] as const;

function readCssRole(name: (typeof cssRoles)[number]) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function Fixture({ service }: { service: ThemeService }) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const [searchValue, setSearchValue] = useState("在主题切换后保留这段文字");
  const [mountCount, setMountCount] = useState(0);
  const [toggleSelected, setToggleSelected] = useState(false);
  const [pressedObservation, setPressedObservation] = useState<null | {
    trigger: string;
    testId: string;
    active: boolean;
    pressed: string | null;
    color: string;
    background: string;
    border: string;
    indicator: string;
  }>(null);

  useEffect(() => {
    setMountCount((count) => count + 1);
  }, []);

  const selectedThemeId = snapshot.theme?.id ?? "";
  const themeDetails = JSON.stringify(Object.fromEntries(cssRoles.map((role) => [role, readCssRole(role)])));
  const themeOrder = [
    "lodestory.builtin.dark",
    "lodestory.builtin.light",
    "lodestory.fixture.cobalt",
    "lodestory.fixture.ember",
  ];
  const themesInFixtureOrder = themeOrder
    .map((id) => snapshot.themes.find((theme) => theme.id === id))
    .filter((theme): theme is NonNullable<typeof theme> => theme !== undefined);

  function observePressedElement(target: EventTarget | null, trigger: string) {
    if (!(target instanceof Element)) return;
    const button = target.closest("button");
    if (!button) return;
    const style = getComputedStyle(button);
    setPressedObservation({
      trigger,
      testId: button.dataset.testid ?? button.getAttribute("aria-label") ?? "未标记按钮",
      active: button.matches(":active"),
      pressed: button.getAttribute("aria-pressed"),
      color: style.color,
      background: style.backgroundColor,
      border: style.borderColor,
      indicator: style.getPropertyValue("--ui-accent-indicator").trim() || readCssRole("--ui-accent-indicator"),
    });
  }

  return (
    <main
      className="fixture"
      data-testid="fixture-app"
      data-mount-count={mountCount}
      onMouseDownCapture={(event) => observePressedElement(event.target, "mouse")}
      onKeyDownCapture={(event) => {
        if (event.key === " " || event.key === "Enter") observePressedElement(event.target, `key:${event.key === " " ? "Space" : "Enter"}`);
      }}
    >
      <header className="fixture__header">
        <div>
          <p className="fixture__eyebrow">UI 主题验收</p>
          <h1>主题与交互状态验收</h1>
        </div>
        <div className="fixture__controls">
          <label className="fixture__theme-control">
            <span>当前主题</span>
            <select
              aria-label="当前主题"
              data-testid="theme-select"
              value={selectedThemeId}
              onChange={(event) => service.setPreference({ mode: "fixed", themeId: event.currentTarget.value })}
            >
              {themesInFixtureOrder.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.id.startsWith("lodestory.builtin.") ? "内置" : "自定义"} · {theme.name}（{theme.type}）
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="secondary"
            aria-pressed={toggleSelected}
            selectionActive={toggleSelected ? true : undefined}
            data-testid="button-toggle-selection"
            onClick={() => setToggleSelected((selected) => !selected)}
          >
            {toggleSelected ? "取消选中" : "切换为选中"}
          </Button>
          <output className="fixture__mount" aria-label="组件挂载次数">组件挂载 {mountCount}</output>
        </div>
      </header>

      <output
        id="theme-debug"
        className="fixture__debug"
        data-testid="theme-debug"
        data-theme-id={snapshot.theme?.id ?? ""}
        data-theme-type={snapshot.theme?.type ?? ""}
        data-preference-mode={snapshot.preference.mode}
        data-action-foreground={readCssRole("--ui-action-foreground")}
        data-accent-indicator={readCssRole("--ui-accent-indicator")}
        data-legacy-on-action={readCssRole("--ui-text-on-action")}
        data-selected-foreground={readCssRole("--ui-state-selected-foreground")}
        data-inactive-selected-foreground={readCssRole("--ui-state-inactive-selected-foreground")}
        data-disabled-selected-foreground={readCssRole("--ui-state-disabled-selected-foreground")}
        data-caret-foreground={readCssRole("--ui-caret-foreground")}
        data-selection-foreground={readCssRole("--ui-selection-foreground")}
        data-selection-background={readCssRole("--ui-text-selection-bg")}
        data-focus-ring={readCssRole("--ui-focus-ring")}
        data-focus-inverse-ring={readCssRole("--ui-focus-inverse-ring")}
        data-css-roles={themeDetails}
      >
        主题：{snapshot.theme?.name ?? "等待主题"} · 类型：{snapshot.theme?.type ?? "—"} · CSS 角色值见 data-css-roles
      </output>

      <output
        className="fixture__pressed-observation"
        data-testid="pressed-observation"
        data-trigger={pressedObservation?.trigger ?? "none"}
        data-button-testid={pressedObservation?.testId ?? ""}
        data-active={pressedObservation?.active ?? false}
        data-aria-pressed={pressedObservation?.pressed ?? ""}
        data-color={pressedObservation?.color ?? ""}
        data-background={pressedObservation?.background ?? ""}
        data-border={pressedObservation?.border ?? ""}
        data-indicator={pressedObservation?.indicator ?? ""}
      >
        {pressedObservation
          ? `${pressedObservation.trigger} · ${pressedObservation.testId} · :active=${pressedObservation.active} · aria-pressed=${pressedObservation.pressed ?? "—"} · color=${pressedObservation.color} · background=${pressedObservation.background} · border=${pressedObservation.border} · indicator=${pressedObservation.indicator}`
          : "点击按钮或聚焦后按 Space / Enter，记录按压瞬态样式。"}
      </output>

      <section className="fixture__panel" aria-labelledby="buttons-title">
        <div className="fixture__section-heading">
          <h2 id="buttons-title">Button · 四种变体与选择状态</h2>
          <p>每行依次为普通、选中、混合选中、失焦选中、禁用、禁用选中。</p>
        </div>
        <div className="button-matrix">
          {(["primary", "secondary", "ghost", "danger"] as const).map((variant) => (
            <div className="button-matrix__row" key={variant} data-variant={variant}>
              <span className="button-matrix__name">{variant}</span>
              <Button variant={variant} focusSurface={variant === "primary" ? "neutral" : undefined} data-testid={`button-${variant}-normal`}><Icon name="check" />普通</Button>
              <Button variant={variant} aria-pressed="true" selectionActive data-testid={`button-${variant}-selected`}><Icon name="check" />选中</Button>
              <Button variant={variant} aria-pressed="mixed" selectionActive data-testid={`button-${variant}-mixed`}><Icon name="more" />混合</Button>
              <Button variant={variant} aria-pressed="true" selectionActive={false} data-testid={`button-${variant}-inactive-selected`}><Icon name="check" />失焦选中</Button>
              <Button variant={variant} disabled data-testid={`button-${variant}-disabled`}>禁用</Button>
              <Button variant={variant} disabled aria-pressed="true" data-testid={`button-${variant}-disabled-selected`}>禁用选中</Button>
            </div>
          ))}
        </div>
      </section>

      <div className="fixture__columns">
        <section className="fixture__panel" aria-labelledby="icon-title">
          <div className="fixture__section-heading"><h2 id="icon-title">IconButton · Icon</h2></div>
          <div className="icon-samples">
            <IconButton label="普通图标按钮"><Icon name="settings" /></IconButton>
            <IconButton label="选中图标按钮" aria-pressed="true" selectionActive><Icon name="checkCircle" /></IconButton>
            <IconButton label="失焦选中图标按钮" aria-pressed="true" selectionActive={false}><Icon name="history" /></IconButton>
            <IconButton label="禁用图标按钮" disabled><Icon name="close" /></IconButton>
            <span className="icon-swatch icon-swatch--primary" aria-label="动作前景图标"><Icon name="folder" size="medium" /></span>
            <span className="icon-swatch icon-swatch--selected" aria-label="选中前景图标"><Icon name="book" size="medium" /></span>
            <span className="icon-swatch icon-swatch--muted" aria-label="次要前景图标"><Icon name="search" size="small" /></span>
          </div>
          <p className="fixture__hint">图标采用 currentColor；切换主题观察按钮和独立图标的角色色。</p>
        </section>

        <section className="fixture__panel" aria-labelledby="search-title">
          <div className="fixture__section-heading"><h2 id="search-title">SearchField · 输入状态</h2></div>
          <div className="search-samples">
            <SearchField
              label="可编辑搜索（测试光标与选区）"
              data-testid="search-editable"
              focusSurface="neutral"
              value={searchValue}
              onChange={(event) => setSearchValue(event.currentTarget.value)}
            />
            <SearchField label="错误搜索" aria-invalid="true" defaultValue="无效内容" data-testid="search-invalid" />
            <SearchField label="只读搜索" readOnly defaultValue="只读但仍可选择文字" data-testid="search-readonly" />
            <SearchField label="禁用搜索" disabled defaultValue="不可编辑" data-testid="search-disabled" />
            <SearchField label="禁用错误搜索" disabled aria-invalid="true" defaultValue="禁用时错误状态仍保留" data-testid="search-disabled-invalid" />
          </div>
        </section>
      </div>

      <section className="fixture__panel inverse-surface" aria-labelledby="inverse-title">
        <div className="fixture__section-heading">
          <h2 id="inverse-title">反色邻面 · focusSurface="inverse"</h2>
          <p>将焦点移到控件，检查焦点环使用反色邻面专用颜色。</p>
        </div>
        <div className="inverse-surface__controls">
          <Button variant="primary" focusSurface="inverse" data-testid="inverse-focus-button"><Icon name="focus" />反色邻面按钮</Button>
          <Button variant="ghost" focusSurface="inverse" data-testid="inverse-ghost-button"><Icon name="history" />反色幽灵按钮</Button>
          <IconButton label="反色邻面图标按钮" focusSurface="inverse" data-testid="inverse-icon-button"><Icon name="settings" /></IconButton>
          <SearchField label="反色邻面搜索" focusSurface="inverse" defaultValue="Tab 到这里检查焦点环" data-testid="inverse-focus-search" />
        </div>
      </section>
    </main>
  );
}

async function startFixture() {
  const status = document.getElementById("startup-status");
  let core: EngineCore | undefined;
  let root: ReturnType<typeof createRoot> | undefined;
  let stopped = false;
  async function stopFixture() {
    stopped = true;
    const mountedRoot = root;
    const runningCore = core;
    root = undefined;
    core = undefined;
    try {
      mountedRoot?.unmount();
    } finally {
      await runningCore?.unmountAll();
    }
  }
  const onUnload = () => { void stopFixture().catch(console.error); };
  import.meta.hot?.dispose(() => {
    window.removeEventListener("beforeunload", onUnload);
    void stopFixture().catch(console.error);
  });
  try {
    core = new EngineCore();
    await core.start([
      uiHarnessPlugin,
      createThemePlugin(themeConfig),
      createBuiltinThemesPlugin(),
      fixtureThemePlugin,
    ]);
    if (stopped) return;
    const theme = core.get(themeKey);
    const themeWrapper = wrappers.get("theme");
    if (!themeWrapper) throw new Error("Theme plugin did not register its UI wrapper.");
    await themeWrapper.prepare?.();
    if (stopped) return;
    const wrapped = themeWrapper.wrap(createElement(Fixture, { service: theme }));
    root = createRoot(document.getElementById("root")!);
    root.render(wrapped);
    if (status) {
      status.textContent = "主题插件已启动";
      status.hidden = true;
    }
    window.addEventListener("beforeunload", onUnload, { once: true });
  } catch (error) {
    try {
      await stopFixture();
    } catch (cleanupError) {
      console.error("Fixture cleanup failed", cleanupError);
    }
    if (status) status.textContent = `启动失败：${String(error)}`;
    console.error(error);
  }
}

void startFixture();
