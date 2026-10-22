import { createElement, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "@lodestory/sdk";
import { uiKey, type UiService, type UiWrapper } from "@lodestory/sdk/ui";
import { themeKey, type ThemeService } from "@lodestory/sdk/theme";
import { Dialog, DialogActions, DialogClose, Icon, Button, Select } from "@lodestory/ui";
import "@lodestory/ui/styles.css";
import "../../src/styles/theme-colors.css";
import "../../src/styles/tokens.css";
import "./ui-dialog.css";
import { EngineCore } from "../../src/plugin-core";
import { createBuiltinThemesPlugin } from "../../src/plugins/builtin-themes/builtinThemesPlugin";
import { createThemePlugin } from "../../src/plugins/theme/themePlugin";
import { NewProjectDialog } from "../../src/plugins/welcome/NewProjectDialog";
import { NewDocumentDialog } from "../../src/plugins/project-management/NewDocumentDialog";
import { DeleteDocumentDialog } from "../../src/plugins/project-management/DeleteDocumentDialog";
import type { ProjectTreeEntry } from "../../src/plugins/project-management/projectManagementModel";

const wrappers = new Map<string, UiWrapper>();
const uiService: UiService = {
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
  id: "ui-dialog-fixture-host",
  requires: [],
  provides: [uiKey],
  activate(context) { context.provide(uiKey, uiService); },
};

const themeConfig = {
  defaultThemeId: "lodestory.builtin.dark",
  fallbackThemeIds: { dark: "lodestory.builtin.dark", light: "lodestory.builtin.light" },
} as const;

type DialogKind = "project" | "document" | "delete";
type Outcome = "success" | "error";

const sampleEntries: readonly ProjectTreeEntry[] = [
  { path: "chapters", name: "chapters", children: [
    { path: "chapters/arc-one", name: "arc-one", children: [] },
  ] },
  { path: "notes", name: "notes", children: [] },
];

const longDeletePath = `书稿/archives/${"特别长的历史篇章目录".repeat(22)}/请确认删除的章节.lode`;

function ThemePicker({ service, compact = false }: { service: ThemeService; compact?: boolean }) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const themes = ["lodestory.builtin.dark", "lodestory.builtin.light"]
    .map((id) => snapshot.themes.find((theme) => theme.id === id))
    .filter((theme): theme is NonNullable<typeof theme> => theme !== undefined);

  return <label className={compact ? "fixture-theme fixture-theme--compact" : "fixture-theme"}>
    <span>当前主题</span>
    <Select
      id={compact ? "dialog-theme-select" : "theme-select"}
      aria-label="当前主题"
      value={snapshot.theme?.id ?? ""}
      onValueChange={(themeId) => service.setPreference({ mode: "fixed", themeId })}
      options={themes.map((theme) => ({
        value: theme.id,
        label: `${theme.name}（${theme.type}）`,
      }))}
    />
  </label>;
}

function StandaloneDialog({ service }: { service: ThemeService }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const finish = (value: "已完成" | "模拟失败") => {
    setPending(false);
    setResult(value);
  };

  return <section className="fixture-section" aria-labelledby="standalone-title">
    <div className="fixture-section__header">
      <div>
        <h2 id="standalone-title">仅依赖 UI 包的弹框</h2>
        <p>此区域使用包内 Dialog 与 UI 样式，不加载应用样式表。</p>
      </div>
      <Button data-testid="standalone-open" ref={trigger} onClick={() => { setResult(""); setOpen(true); }}>
        打开独立弹框
      </Button>
    </div>
    <output className="fixture-result" aria-live="polite">{result || "尚无模拟操作"}</output>
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="通用弹框"
      description="主题、焦点管理、遮罩与关闭行为由 UI 包提供。"
      busy={pending}
      initialFocus={name}
      finalFocus={trigger}
    >
      <div className="standalone-content">
        <ThemePicker service={service} compact />
        <label className="fixture-field">
          <span>弹框内输入</span>
          <input ref={name} data-testid="standalone-name" defaultValue="主题切换后保留" />
        </label>
        <p className="fixture-help">切换上方主题，观察弹框、遮罩及焦点颜色是否同步。</p>
        {pending && <p className="fixture-pending" role="status">处理中…现在可以按 Escape 或点击取消按钮测试 busy 保护。</p>}
        <DialogActions>
          {pending
            ? <>
              <DialogClose disabled>处理中不可取消</DialogClose>
              <Button variant="secondary" onClick={() => finish("模拟失败")}>结束并模拟失败</Button>
              <Button variant="primary" onClick={() => finish("已完成")}>结束并模拟成功</Button>
            </>
            : <>
              <DialogClose onClick={() => setResult("已取消")}>取消</DialogClose>
              <Button variant="primary" data-testid="standalone-begin" onClick={() => setPending(true)}>开始模拟操作</Button>
            </>}
        </DialogActions>
      </div>
    </Dialog>
  </section>;
}

function BusinessDialogs() {
  const [kind, setKind] = useState<DialogKind | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("error");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [event, setEvent] = useState("");

  function openDialog(next: DialogKind) {
    setError(null);
    setEvent("");
    setKind(next);
  }

  async function runBusinessAction(label: string) {
    setBusy(true);
    setError(null);
    setEvent(`${label}：处理中（1 秒）`);
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    setBusy(false);
    if (outcome === "error") {
      setError(`模拟失败：${label}未完成，请保留输入后重试。`);
      setEvent(`${label}：失败后仍留在当前弹框`);
      return;
    }
    setEvent(`${label}：模拟完成，没有写入任何文件`);
    setKind(null);
  }

  const buttons = [
    ["project", "新建项目"],
    ["document", "新建文档／文件夹"],
    ["delete", "删除长路径文档"],
  ] as const;

  return <section className="fixture-section" aria-labelledby="business-title">
    <div className="fixture-section__header">
      <div>
        <h2 id="business-title">迁移后的三个业务弹框</h2>
        <p>文件操作由 fixture 回调模拟，不会选择真实目录或写入文件。</p>
      </div>
      <label className="fixture-theme fixture-theme--compact">
        <span>模拟提交结果</span>
        <Select
          id="business-outcome-select"
          aria-label="模拟提交结果"
          value={outcome}
          onValueChange={(value) => setOutcome(value as Outcome)}
          options={[
            { value: "error", label: "延时失败" },
            { value: "success", label: "延时成功" },
          ]}
        />
      </label>
    </div>
    <div className="fixture-business-actions">
      {buttons.map(([id, label]) => <Button
        key={id}
        data-testid={`open-${id}`}
        disabled={busy}
        onClick={() => openDialog(id)}
      >{label}</Button>)}
    </div>
    <output className="fixture-result" aria-live="polite">{event || "先选择测试结果，再打开一个弹框"}</output>

    {kind === "project" && <NewProjectDialog
      busy={busy}
      error={error}
      onClose={() => setKind(null)}
      onPickDirectory={async () => "测试目录/示例项目"}
      onCreate={async () => runBusinessAction("新建项目")}
    />}
    {kind === "document" && <NewDocumentDialog
      projectName="示例项目"
      entries={sampleEntries}
      initialParent="chapters"
      kind="document"
      extension="lode"
      busy={busy}
      error={error}
      onClose={() => setKind(null)}
      onCreate={async () => runBusinessAction("新建文档")}
    />}
    {kind === "delete" && <DeleteDocumentDialog
      path={longDeletePath}
      busy={busy}
      error={error}
      onClose={() => setKind(null)}
      onDelete={() => runBusinessAction("删除文档")}
    />}
  </section>;
}

function App({ service }: { service: ThemeService }) {
  return <main className="fixture">
    <header className="fixture-header">
      <div className="fixture-brand">
        <Icon name="more" size="small" />
        <h1>UI Dialog 主题与交互验收</h1>
      </div>
      <ThemePicker service={service} />
    </header>
    <p className="fixture-intro">同一套 Dialog 外壳由 UI 包提供，表单、提交状态和业务反馈仍由各插件提供。</p>
    <StandaloneDialog service={service} />
    <BusinessDialogs />
    <footer className="fixture-footer">
      <span>验收提示：用 Tab／Escape 测焦点与关闭；业务表单提交后可检查处理中、失败保留和取消保护。</span>
      <a href="/tests/fixtures/ui-theme.html">返回 UI 组件主题验收</a>
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
    await core.start([uiHarnessPlugin, createThemePlugin(themeConfig), createBuiltinThemesPlugin()]);
    if (stopped) return;
    const service = core.get(themeKey);
    const wrapper = wrappers.get("theme");
    if (!wrapper) throw new Error("Theme plugin did not register its UI wrapper.");
    await wrapper.prepare?.();
    if (stopped) return;
    root = createRoot(document.getElementById("root")!);
    root.render(wrapper.wrap(createElement(App, { service })));
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
