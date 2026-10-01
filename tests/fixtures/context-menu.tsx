import React, { forwardRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Dialog } from "@base-ui/react/dialog";
import { ContextMenuProvider, ContextMenuRegion, useContextMenus, type MenuEntry } from "../../src/components/context-menu";
import "../../src/styles.css";

const CustomButton = forwardRef<HTMLButtonElement, React.ComponentProps<"button">>((props, ref) => <button {...props} ref={ref} className="button" />);

function Fixture() {
  const menus = useContextMenus();
  const [target, setTarget] = useState("A");
  const [result, setResult] = useState("未执行");
  const [enabled, setEnabled] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [checks, setChecks] = useState<string[]>([]);
  const [theme, setTheme] = useState("dark");
  const [density, setDensity] = useState<"comfortable" | "spacious" | "compact">("comfortable");
  const entries = (context: string): MenuEntry<string>[] => [
    { id: "head", type: "separator" },
    { id: "hidden", label: "隐藏动作", visible: false, onSelect: () => {} },
    { id: "pick", label: `记录 ${context}`, disabled: !enabled, onSelect: async (value) => { await new Promise((resolve) => setTimeout(resolve, 300)); setResult(`执行目标 ${value}`); } },
    { id: "gap", type: "separator" },
    { id: "group", type: "group", label: "更多", items: [
      { id: "sub", type: "submenu", label: "子菜单", items: [{ id: "child", label: "子动作", onSelect: (value) => setResult(`子动作 ${value}`) }] },
    ] },
    { id: "tail", type: "separator" },
  ];

  async function checkInteractions() {
    const messages: string[] = [];
    const check = (condition: boolean, name: string) => { if (!condition) throw new Error(name); messages.push(`通过：${name}`); };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
    const rightClick = (id: string, point?: { x: number; y: number }) => {
      const element = document.getElementById(id)!;
      const rect = element.getBoundingClientRect();
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: point?.x ?? rect.left + 8, clientY: point?.y ?? rect.top + 8 });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const menuCount = () => document.querySelectorAll('[role="menu"]:not([data-ending-style])').length;
    try {
      flushSync(() => { setMounted(true); setEnabled(true); setTarget("A"); });
      check(rightClick("inner"), "内层区域显示自定义菜单");
      await settle();
      check(menuCount() === 1 && !!document.querySelector('[role="menu"][aria-label="内层菜单"]'), "嵌套区域只显示一个菜单");
      check(!rightClick("native-input"), "输入框保留默认行为");
      await settle();
      check(menuCount() === 0, "原生区域不会打开父菜单");
      check(!rightClick("empty"), "空配置保留默认行为");
      await settle();
      check(menuCount() === 0, "空区域不会回退父菜单");
      rightClick("inner");
      await settle();
      flushSync(() => setTarget("B"));
      check(document.querySelector('[role="menuitem"]')?.textContent === "记录 A", "菜单打开后目标保持固定");
      (document.querySelector('[role="menuitem"]') as HTMLElement).click();
      await settle();
      rightClick("inner");
      await settle();
      check(document.querySelector('[role="menuitem"]')?.getAttribute("aria-disabled") === "true", "异步动作防重复提交");
      await new Promise((resolve) => setTimeout(resolve, 200));
      check(document.querySelector("output")?.textContent === "执行目标 A", "动作使用打开时的目标");
      rightClick("portal-region");
      await settle();
      check(menuCount() === 1 && !!document.querySelector('[role="menu"][aria-label="Portal 菜单"]'), "Portal 区域替换上一菜单");
      menus.closeAll();
      await settle();
      rightClick("inner");
      await settle();
      flushSync(() => setMounted(false));
      await settle();
      check(menuCount() === 0, "区域卸载关闭菜单");
      flushSync(() => { setMounted(true); menus.closeAll(); setDialogOpen(true); });
      await settle();
      rightClick("dialog-region");
      await settle();
      check(!!document.querySelector('[role="menu"][aria-label="对话框菜单"]'), "模态对话框内可以复用组件");
      menus.closeAll();
      flushSync(() => setDialogOpen(false));
      await settle();
      check(!rightClick("native-region"), "显式原生区域保留默认行为");
      check(rightClick("custom-input"), "输入区域可以显式配置自定义菜单");
      await settle();
      check(!!document.querySelector('[role="menu"][aria-label="输入菜单"]'), "自定义输入菜单可展示");
      menus.closeAll();
      await settle();
      const corners = [{ x: 1, y: 1 }, { x: innerWidth - 1, y: 1 }, { x: 1, y: innerHeight - 1 }, { x: innerWidth - 1, y: innerHeight - 1 }];
      for (const [index, point] of corners.entries()) {
        rightClick("inner", point);
        await settle();
        const rect = document.querySelector('[role="menu"]')!.getBoundingClientRect();
        check(rect.left >= 15 && rect.top >= 15 && rect.right <= innerWidth - 15 && rect.bottom <= innerHeight - 15, `窗口边角 ${index + 1} 避让`);
        menus.closeAll();
        await settle();
      }
      rightClick("long-menu", { x: innerWidth / 2, y: 16 });
      await settle();
      const popup = document.querySelector('[role="menu"]') as HTMLElement;
      check(popup.scrollHeight > popup.clientHeight, "长菜单限制高度并允许内部滚动");
      popup.scrollTop = 48;
      popup.dispatchEvent(new Event("scroll"));
      await settle();
      check(menuCount() === 1, "菜单自身滚动保持打开");
      document.getElementById("outer")!.dispatchEvent(new Event("scroll"));
      await settle();
      check(menuCount() === 0, "触发区域滚动关闭菜单");
      rightClick("inner");
      await settle();
      window.dispatchEvent(new Event("resize"));
      await settle();
      check(menuCount() === 0, "窗口尺寸变化关闭菜单");
      setChecks(messages);
    } catch (error) { menus.closeAll(); setChecks([...messages, `失败：${String(error)}`]); }
  }

  return <main data-ui-theme={theme} data-ui-density={density} style={{ padding: 32, minHeight: "100vh", background: "var(--ui-surface-workspace)", color: "var(--ui-text-primary)" }}>
    <h1>右键菜单组件验证</h1>
    <p>此页面使用字符串上下文，不涉及项目、文档或磁盘操作。</p>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBlock: 16 }}>
      <button className="button" onClick={() => void checkInteractions()}>运行交互检查</button>
      <button className="button" onClick={() => setTarget(target === "A" ? "B" : "A")}>切换目标</button>
      <button className="button" onClick={() => setEnabled(!enabled)}>切换禁用</button>
      <button className="button" onClick={() => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); document.documentElement.dataset.uiTheme = next; }}>切换主题</button>
      <select aria-label="界面密度" value={density} onChange={(event) => setDensity(event.target.value as typeof density)}>
        <option value="comfortable">Comfortable</option><option value="spacious">Spacious</option><option value="compact">Compact</option>
      </select>
      <button className="button" onClick={() => { menus.closeAll(); setDialogOpen(true); }}>打开对话框</button>
    </div>
    <output aria-live="polite">{result}</output>
    <ContextMenuRegion label="外层菜单" items={[{ id: "outer", label: "外层动作", onSelect: () => setResult("外层") }]}>
      <section id="outer" tabIndex={0} style={{ marginBlock: 24, padding: 24, border: "1px solid var(--ui-border-divider)", height: 260, overflowY: "auto" }}>
        <p>外层空白区域</p>
        {mounted && <ContextMenuRegion context={target} label="内层菜单" items={entries}>
          <CustomButton id="inner">内层自定义组件 {target}</CustomButton>
        </ContextMenuRegion>}
        <ContextMenuRegion items={[]}><button id="empty" className="button">空菜单区域</button></ContextMenuRegion>
        <ContextMenuRegion mode="native"><button id="native-region" className="button">原生区域</button></ContextMenuRegion>
        <ContextMenuRegion label="长菜单" items={Array.from({ length: 40 }, (_value, index) => ({ id: `long-${index}`, label: `操作 ${index + 1}`, onSelect: () => setResult(`长菜单 ${index + 1}`) }))}>
          <button id="long-menu" className="button">长菜单区域</button>
        </ContextMenuRegion>
        <p><textarea id="native-input" aria-label="原生正文" defaultValue="保留文字选区和撤销" /></p>
        <ContextMenuRegion mode="custom" label="输入菜单" items={[{ id: "input", label: "输入区域动作", onSelect: () => setResult("输入") }]}>
          <textarea id="custom-input" aria-label="自定义正文" defaultValue="显式启用自定义菜单" />
        </ContextMenuRegion>
        <div style={{ height: 500 }} />
      </section>
    </ContextMenuRegion>
    {createPortal(<ContextMenuRegion label="Portal 菜单" items={[{ id: "portal", label: "Portal 动作", onSelect: () => setResult("Portal") }]}>
      <button id="portal-region" className="button" style={{ position: "fixed", right: 16, bottom: 16 }}>Portal 区域</button>
    </ContextMenuRegion>, document.body)}
    <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
      <Dialog.Portal><Dialog.Backdrop className="project-dialog-backdrop" /><Dialog.Popup className="project-dialog">
        <Dialog.Title>对话框内复用</Dialog.Title>
        <Dialog.Description>此区域复用相同公共菜单组件。</Dialog.Description>
        <ContextMenuRegion label="对话框菜单" items={[{ id: "dialog", label: "对话框动作", onSelect: () => setResult("对话框") }]}>
          <button id="dialog-region" className="button">对话框响应区域</button>
        </ContextMenuRegion>
        <Dialog.Close className="button">关闭对话框</Dialog.Close>
      </Dialog.Popup></Dialog.Portal>
    </Dialog.Root>
    <ul aria-label="检查结果">{checks.map((message) => <li key={message}>{message}</li>)}</ul>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><ContextMenuProvider><Fixture /></ContextMenuProvider></React.StrictMode>);
