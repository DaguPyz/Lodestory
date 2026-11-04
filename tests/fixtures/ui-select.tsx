import { createElement, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "@lodestory/sdk";
import { uiKey, type UiService, type UiWrapper } from "@lodestory/sdk/ui";
import { themeKey, type ThemeDefinition, type ThemeService } from "@lodestory/sdk/theme";
import { Button, Dialog, DialogActions, DialogClose, Select } from "@lodestory/ui";
import "@lodestory/ui/styles.css";
import "../../src/styles/tokens.css";
import "./ui-select.css";
import { EngineCore } from "../../src/plugin-core";
import { createBuiltinThemesPlugin } from "../../src/plugins/builtin-themes/builtinThemesPlugin";
import { createThemePlugin } from "../../src/plugins/theme/themePlugin";

const themeConfig = {
  defaultThemeId: "lodestory.builtin.dark",
  fallbackThemeIds: { dark: "lodestory.builtin.dark", light: "lodestory.builtin.light" },
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
      "surface.floating": "#1C2C47",
      "text.primary": "#E7EEFF",
      "text.secondary": "#BDC9E3",
      "text.placeholder": "#99A9C9",
      "border.strong": "#62779F",
      "border.divider": "#3A4A66",
      "action.background": "#365BE8",
      "action.foreground": "#B5FF4B",
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
      "state.disabledBackground": "#252A36",
      "state.disabledForeground": "#9AA6BD",
      "focus.ring": "#A7D9FF",
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
      "surface.floating": "#3F2919",
      "text.primary": "#FFF0DE",
      "text.secondary": "#E5C8A8",
      "text.placeholder": "#C7A789",
      "border.strong": "#8C6B4A",
      "border.divider": "#634A34",
      "action.background": "#B85219",
      "action.foreground": "#1B150D",
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
      "state.disabledBackground": "#392F28",
      "state.disabledForeground": "#C0A990",
      "focus.ring": "#FFD7A1",
    },
  },
];

const themeRemovers: (() => void)[] = [];
const wrappers = new Map<string, UiWrapper>();
const uiService: UiService = {
  registerOverlay: () => () => {},
  hasActiveOverlay: () => false,
  registerPage: () => () => {},
  addWrapper(wrapper) {
    wrappers.set(wrapper.id, wrapper);
    return () => { if (wrappers.get(wrapper.id) === wrapper) wrappers.delete(wrapper.id); };
  },
  registerNavigationGuard: () => () => {},
  openPage: async () => false,
  back: async () => true,
  getSnapshot: () => ({ current: null, pages: [], canGoBack: false }),
  subscribe: () => () => {},
};

const uiHarnessPlugin: Plugin = {
  id: "ui-select-fixture-host",
  requires: [],
  provides: [uiKey],
  activate(context) { context.provide(uiKey, uiService); },
};

const fixtureThemePlugin: Plugin = {
  id: "ui-select-fixture-themes",
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

const themeOrder = [
  "lodestory.builtin.dark",
  "lodestory.builtin.light",
  "lodestory.fixture.cobalt",
  "lodestory.fixture.ember",
];

const basicOptions = [
  { value: "chapter", label: "章节" },
  { value: "character", label: "人物设定" },
  { value: "world", label: "世界观资料" },
] as const;

const disabledOptions = [
  { value: "active", label: "可用章节" },
  { value: "archived", label: "归档章节（禁用项）", disabled: true },
  { value: "draft", label: "草稿章节" },
] as const;

const longLabel = "这是一条很长的选择项，用来观察文字换行、弹层宽度和窄屏下的内容裁切是否合理。".repeat(2);
const longOptions = [
  { value: "memo", label: longLabel },
  { value: "brief", label: "简短选项" },
] as const;

const listOptions = Array.from({ length: 72 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0");
  return { value: `chapter-${number}`, label: `第 ${number} 章 · 正文与创作资料` };
});

function themeOptions(snapshot: ReturnType<ThemeService["getSnapshot"]>) {
  return themeOrder
    .map((id) => snapshot.themes.find((theme) => theme.id === id))
    .filter((theme): theme is NonNullable<typeof theme> => theme !== undefined)
    .map((theme) => ({
      value: theme.id,
      label: `${theme.id.startsWith("lodestory.builtin.") ? "内置" : "自定义"} · ${theme.name}（${theme.type}）`,
    }));
}

function ThemePicker({ service }: { service: ThemeService }) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const currentType = snapshot.theme?.type ?? "—";
  return <div className="fixture__theme-control">
    <label className="fixture__field" htmlFor="current-theme">
      <span>当前主题</span>
      <Select
        id="current-theme"
        aria-label="当前主题"
        value={snapshot.theme?.id ?? null}
        onValueChange={(themeId) => service.setPreference({ mode: "fixed", themeId })}
        options={themeOptions(snapshot)}
      />
    </label>
    <output className="fixture__theme-status" data-theme-type={currentType}>
      {snapshot.theme?.name ?? "等待主题"} · type={currentType}
    </output>
  </div>;
}

function Fixture({ service }: { service: ThemeService }) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const [basicValue, setBasicValue] = useState<string>("chapter");
  const [basicClicks, setBasicClicks] = useState(0);
  const [basicDisabled, setBasicDisabled] = useState(false);
  const [keyboardMessage, setKeyboardMessage] = useState("等待快捷键操作");
  const [disabledOptionValue, setDisabledOptionValue] = useState<string>("active");
  const [placeholderValue, setPlaceholderValue] = useState<string | null>(null);
  const [emptyValue, setEmptyValue] = useState<string>("named");
  const [longValue, setLongValue] = useState<string>("memo");
  const [listValue, setListValue] = useState<string>("chapter-42");
  const [formValue, setFormValue] = useState<string>("lode");
  const [formResult, setFormResult] = useState<string>("尚未提交");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogValue, setDialogValue] = useState<string>("character");
  const [dialogSelectOpen, setDialogSelectOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogSelectRef = useRef<HTMLButtonElement>(null);
  const currentThemeId = snapshot.theme?.id ?? "";

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === "t") {
        event.preventDefault();
        const availableIds = themeOrder.filter((id) => snapshotRef.current.themes.some((theme) => theme.id === id));
        const index = availableIds.indexOf(snapshotRef.current.theme?.id ?? "");
        const nextId = availableIds[(index + 1 + availableIds.length) % availableIds.length];
        if (nextId) {
          service.setPreference({ mode: "fixed", themeId: nextId });
          setKeyboardMessage(`Alt+T 已切换主题：${nextId}`);
        }
      } else if (key === "d") {
        event.preventDefault();
        setBasicDisabled((disabled) => !disabled);
        setKeyboardMessage("Alt+D 已切换普通选择器禁用状态");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [service]);

  return <main className="fixture" data-theme-id={currentThemeId} data-theme-type={snapshot.theme?.type ?? ""}>
    <header className="fixture__header">
      <div>
        <h1>Select 验收</h1>
        <p>检查主题联动、键盘操作、禁用状态、空值、长列表与表单提交。</p>
      </div>
      <ThemePicker service={service} />
    </header>

    <section className="fixture__section" aria-labelledby="state-title">
      <div className="fixture__section-heading">
        <h2 id="state-title">基础状态</h2>
        <p>普通、整体禁用与单个禁用选项。</p>
      </div>
      <p className="fixture__shortcut-hint">打开普通选择器弹层后按 Alt+T 切换主题，或按 Alt+D 切换禁用状态并验证弹层关闭。快捷键只作用于此验收页。</p>
      <div className="fixture__fields fixture__fields--three">
        <label className="fixture__field" htmlFor="basic-select">
          <span>普通选择</span>
          <Select id="basic-select" aria-label="普通选择" value={basicValue} disabled={basicDisabled} onValueChange={setBasicValue} onClick={() => setBasicClicks((count) => count + 1)} options={basicOptions} />
        </label>
        <label className="fixture__field" htmlFor="disabled-select">
          <span>整体禁用</span>
          <Select id="disabled-select" aria-label="整体禁用" value="chapter" disabled onValueChange={() => {}} options={basicOptions} />
        </label>
        <label className="fixture__field" htmlFor="disabled-option-select">
          <span>含禁用选项</span>
          <Select id="disabled-option-select" aria-label="含禁用选项" value={disabledOptionValue} onValueChange={setDisabledOptionValue} options={disabledOptions} />
        </label>
      </div>
      <output className="fixture__result" aria-live="polite">普通值：{basicValue} · 触发器点击：{basicClicks} 次 · 普通选择器：{basicDisabled ? "禁用" : "启用"} · 禁用项示例值：{disabledOptionValue} · {keyboardMessage}</output>
    </section>

    <section className="fixture__section" aria-labelledby="edge-title">
      <div className="fixture__section-heading">
        <h2 id="edge-title">值与内容边界</h2>
        <p>空值占位、合法空字符串、长选项与 72 条选项。</p>
      </div>
      <div className="fixture__fields fixture__fields--two">
        <label className="fixture__field" htmlFor="placeholder-select">
          <span>空值与 placeholder（value=null）</span>
          <Select
            id="placeholder-select"
            aria-label="空值占位"
            value={placeholderValue}
            onValueChange={setPlaceholderValue}
            options={basicOptions}
            placeholder="请选择一项"
          />
        </label>
        <label className="fixture__field" htmlFor="empty-string-select">
          <span>空字符串（value="" 是合法选项）</span>
          <Select
            id="empty-string-select"
            aria-label="空字符串选项"
            value={emptyValue}
            onValueChange={setEmptyValue}
            options={[
              { value: "", label: "空字符串选项（合法值）" },
              { value: "named", label: "普通值" },
            ]}
          />
        </label>
        <label className="fixture__field" htmlFor="long-option-select">
          <span>超长选项文本</span>
          <Select id="long-option-select" aria-label="超长选项" value={longValue} onValueChange={setLongValue} options={longOptions} />
        </label>
        <label className="fixture__field" htmlFor="long-list-select">
          <span>长列表（72 项）</span>
          <Select id="long-list-select" aria-label="长列表" value={listValue} onValueChange={setListValue} options={listOptions} />
        </label>
      </div>
      <div className="fixture__fields fixture__fields--two">
        <label className="fixture__field" htmlFor="readonly-select">
          <span>只读选择</span>
          <Select id="readonly-select" aria-label="只读选择" value="character" readOnly onValueChange={() => {}} options={basicOptions} />
        </label>
        <div className="fixture__field">
          <span id="invalid-empty-select-label">无可用选项 · aria-invalid</span>
          <Select
            id="invalid-empty-select"
            aria-labelledby="invalid-empty-select-label"
            aria-describedby="invalid-empty-select-help"
            aria-invalid="true"
            value={null}
            onValueChange={() => {}}
            options={[]}
            placeholder="没有可选项目"
          />
          <small id="invalid-empty-select-help" className="fixture__field-hint">打开后应说明暂无选项；触发器带无效状态。</small>
        </div>
      </div>
      <output className="fixture__result" aria-live="polite">placeholder 值：{placeholderValue === null ? "null（未选择）" : placeholderValue} · 空字符串值：{JSON.stringify(emptyValue)} · 长列表值：{listValue}</output>
    </section>

    <div className="fixture__bottom-grid">
      <section className="fixture__section" aria-labelledby="form-title">
        <div className="fixture__section-heading">
          <h2 id="form-title">表单 name 提交</h2>
          <p>提交后读取 FormData 的命名字段。</p>
        </div>
        <form className="fixture__form" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setFormResult(JSON.stringify(data.get("draftFormat")));
        }}>
          <label className="fixture__field" htmlFor="form-select">
            <span>文档格式 · name=draftFormat</span>
            <Select
              id="form-select"
              name="draftFormat"
              aria-label="表单名称字段"
              value={formValue}
              onValueChange={setFormValue}
              options={[
                { value: "lode", label: "Lode 文档" },
                { value: "markdown", label: "Markdown" },
              ]}
              required
            />
          </label>
          <Button type="submit" variant="primary">读取表单值</Button>
        </form>
        <output className="fixture__result" aria-live="polite">FormData.get("draftFormat")：{formResult}</output>
      </section>

      <section className="fixture__section" aria-labelledby="dialog-title">
        <div className="fixture__section-heading">
          <h2 id="dialog-title">Dialog 内嵌</h2>
          <p>在受焦点管理的弹框中打开 Select，并可切换当前主题。</p>
        </div>
        <Button ref={triggerRef} data-testid="open-select-dialog" onClick={() => setDialogOpen(true)}>打开内嵌弹框</Button>
        <output className="fixture__result" aria-live="polite">选择器弹层：{dialogSelectOpen ? "打开" : "关闭"} · 当前值：{dialogValue}</output>
        <Dialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="弹框中的 Select"
          description="选择器浮层应跟随当前主题，并保持可键盘操作。"
          initialFocus={dialogSelectRef}
          finalFocus={triggerRef}
        >
          <div className="fixture__dialog-content">
            <label className="fixture__field" htmlFor="dialog-select">
              <span>弹框内选择</span>
              <Select
                ref={dialogSelectRef}
                id="dialog-select"
                aria-label="弹框中的选择器"
                value={dialogValue}
                onValueChange={setDialogValue}
                onOpenChange={setDialogSelectOpen}
                options={basicOptions}
              />
            </label>
            <label className="fixture__field" htmlFor="dialog-theme-select">
              <span>弹框内切换主题</span>
              <Select
                id="dialog-theme-select"
                aria-label="弹框内切换主题"
                value={snapshot.theme?.id ?? null}
                onValueChange={(themeId) => service.setPreference({ mode: "fixed", themeId })}
                options={themeOptions(snapshot)}
              />
            </label>
          </div>
          <DialogActions>
            <DialogClose>关闭弹框</DialogClose>
          </DialogActions>
        </Dialog>
      </section>
    </div>
    <footer className="fixture__footer">
      <span>自定义主题“钴蓝”和“琥珀”的 type 都是 dark；切换二者可以观察组件是否仅按主题变量变化。</span>
      <a href="/tests/fixtures/ui-dialog.html">打开 Dialog 验收页</a>
    </footer>
  </main>;
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
    try { mountedRoot?.unmount(); }
    finally { await runningCore?.unmountAll(); }
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
    const service = core.get(themeKey);
    const wrapper = wrappers.get("theme");
    if (!wrapper) throw new Error("Theme plugin did not register its UI wrapper.");
    await wrapper.prepare?.();
    if (stopped) return;
    root = createRoot(document.getElementById("root")!);
    root.render(wrapper.wrap(createElement(Fixture, { service })));
    if (status) status.hidden = true;
    window.addEventListener("beforeunload", onUnload, { once: true });
  } catch (error) {
    try { await stopFixture(); }
    catch (cleanupError) { console.error("Fixture cleanup failed", cleanupError); }
    if (status) status.textContent = `启动失败：${String(error)}`;
    console.error(error);
  }
}

void startFixture();
