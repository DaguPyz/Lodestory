import {createRoot} from "react-dom/client";
import type {EditorHandle} from "@lodestory/sdk/body-editor";
import RichTextEditor from "../../src/plugins/rich-text-editor/RichTextEditor";
import {serializeRichDelta} from "../../src/plugins/rich-text-editor/richDeltaFormat";
import "../../src/styles.css";

declare global {
  interface Window {
    __richTextToolbarPreview: {
      ready: boolean;
      error: string | null;
      measure(): {
        viewportWidth: number;
        viewportHeight: number;
        devicePixelRatio: number;
        visualViewportScale: number | null;
        previewCssZoom: number;
        pageClientWidth: number;
        pageScrollWidth: number;
        editorWidth: number;
        toolbarWidth: number;
        toolbarScrollWidth: number;
        openedMenu: null | {
          selector: string;
          visible: boolean;
          x: number;
          y: number;
          width: number;
          height: number;
          scrollWidth: number;
          clientWidth: number;
          withinViewport: boolean;
        };
        controls: Array<{selector: string; count: number; maxWidth: number; maxHeight: number}>;
      };
    };
  }
}

const search = new URLSearchParams(location.search);
const themeId = search.get("theme") === "light" ? "lodestory.builtin.light" : "lodestory.builtin.dark";
const requestedWidth = Number(search.get("width"));
const contentWidth = Number.isFinite(requestedWidth) && requestedWidth >= 320 ? requestedWidth : 720;
const requestedZoom = Number(search.get("zoom"));
const previewCssZoom = requestedZoom === 200 ? 2 : 1;
const readOnly = search.get("readOnly") === "true";
const openPicker = search.get("open");
const pickerLabels: Readonly<Record<string, string>> = {
  font: "字体",
  header: "标题级别",
  size: "字号",
  color: "文字颜色",
  background: "文字背景色",
  align: "段落对齐",
};
const menuSelector = openPicker && pickerLabels[openPicker] ? ".ui-select-popup" : undefined;
let previewInteractionApplied = false;
document.documentElement.dataset.uiThemeId = themeId;
document.documentElement.dataset.uiTheme = themeId.endsWith("light") ? "light" : "dark";
document.documentElement.dataset.uiDensity = "comfortable";
document.documentElement.style.zoom = String(previewCssZoom);

const content = serializeRichDelta([
  {insert: "富文本工具栏预览\n", attributes: {header: 2}},
  {insert: "这里展示", attributes: {font: "Arial", size: "18px"}},
  {insert: "粗体", attributes: {bold: true, color: "#286BB1"}},
  {insert: "、斜体和不同段落格式。\n"},
  {insert: "窄窗口与高倍缩放时，工具栏应该保持可见、可操作，并允许换行。\n"},
  {insert: "居中段落\n", attributes: {align: "center"}},
]);

const root = createRoot(document.getElementById("root")!);
const renderTree = (
  <main className="rich-toolbar-preview-page">
    <section className="rich-toolbar-preview-content" aria-label="正文编辑器预览">
      <RichTextEditor
        documentId="rich-text-toolbar-preview"
        format="rich-delta"
        content={content}
        readOnly={readOnly}
        active
        loadFontFamilies={async () => ["Arial", "Georgia", "Times New Roman", "Courier New"]}
        onChange={() => {}}
        onReady={(handle: EditorHandle | null) => {
          window.__richTextToolbarPreview.ready = handle !== null;
          if (handle) writePreviewMetrics();
        }}
        onError={error => { window.__richTextToolbarPreview.error = error.message; }}
      />
    </section>
  </main>
);

window.__richTextToolbarPreview = {
  ready: false,
  error: null,
  measure() {
    const rectWidth = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0;
    const controls = [
      '.rich-text-font-family [aria-label="字体"]', '.ql-header [aria-label="标题级别"]',
      '.ql-size [aria-label="字号"]', '.ql-color [aria-label="文字颜色"]',
      '.ql-background [aria-label="文字背景色"]', '.ql-align [aria-label="段落对齐"]',
      ".rich-text-toolbar-actions button",
    ].map(selector => {
      const elements = [...document.querySelectorAll<HTMLElement>(selector)];
      return {
        selector,
        count: elements.length,
        maxWidth: Math.max(0, ...elements.map(element => element.getBoundingClientRect().width)),
        maxHeight: Math.max(0, ...elements.map(element => element.getBoundingClientRect().height)),
      };
    });
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      visualViewportScale: window.visualViewport?.scale ?? null,
      previewCssZoom,
      pageClientWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      editorWidth: rectWidth(".rich-toolbar-preview-content"),
      toolbarWidth: rectWidth(".ql-toolbar"),
      toolbarScrollWidth: document.querySelector<HTMLElement>(".ql-toolbar")?.scrollWidth ?? 0,
      openedMenu: measureOpenedMenu(),
      controls,
    };
  },
};

function writePreviewMetrics(attempt = 0) {
  if (search.get("measure") !== "1" || !window.__richTextToolbarPreview.ready) return;
  const selectTriggers = document.querySelectorAll(".ui-select-trigger").length;
  if (selectTriggers < 6 && attempt < 40) {
    window.setTimeout(() => writePreviewMetrics(attempt + 1), 50);
    return;
  }
  if (!previewInteractionApplied) {
    if (search.get("selected") === "bold") document.querySelector<HTMLButtonElement>(".ql-bold")?.click();
    if (search.get("focus") === "bold") document.querySelector<HTMLButtonElement>(".ql-bold")?.focus();
    if (menuSelector) {
      document.querySelector<HTMLButtonElement>(`[aria-label="${pickerLabels[openPicker!]}"]`)?.click();
    }
    previewInteractionApplied = true;
    if (menuSelector) {
      window.setTimeout(() => writePreviewMetrics(attempt + 1), 200);
      return;
    }
  }
  let output = document.getElementById("preview-metrics") as HTMLScriptElement | null;
  if (!output) {
    output = document.createElement("script");
    output.id = "preview-metrics";
    output.type = "application/json";
    document.body.append(output);
  }
  output.dataset.ready = "true";
  output.textContent = JSON.stringify({
    themeId,
    contentWidth,
    readOnly,
    ...window.__richTextToolbarPreview.measure(),
  });
}

function measureOpenedMenu() {
  if (!menuSelector) return null;
  const menu = document.querySelector<HTMLElement>(menuSelector);
  if (!menu) return null;
  const rect = menu.getBoundingClientRect();
  const style = getComputedStyle(menu);
  const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  return {
    selector: menuSelector,
    visible,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    scrollWidth: menu.scrollWidth,
    clientWidth: menu.clientWidth,
    withinViewport: rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight,
  };
}

const style = document.createElement("style");
style.textContent = `
  html, body, #root { min-width: 0; min-height: 100%; margin: 0; }
  body { background: var(--ui-surface-workspace); color: var(--ui-text-primary); }
  .rich-toolbar-preview-page { box-sizing: border-box; min-height: 100vh; padding: 32px 24px; }
  .rich-toolbar-preview-content { width: min(${contentWidth}px, 100%); margin: 0 auto; }
  @media (max-width: 480px) { .rich-toolbar-preview-page { padding: 16px; } }
`;
document.head.append(style);
root.render(renderTree);
