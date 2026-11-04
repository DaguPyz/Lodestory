import {useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent} from "react";
import {Button, SearchField, TextField} from "@lodestory/ui";
import {shortcutScopeIds, type ShortcutSnapshot, type ShortcutsService} from "@lodestory/sdk/shortcuts";
import {formatShortcut, isMacPlatform, shortcutFromKeyEvent} from "./shortcutsStore";
import type {ShortcutSettingsModel} from "./shortcutSettingsModel";
import "./shortcut-settings.css";

type Binding = ShortcutSnapshot["bindings"][number];
type Command = ShortcutSnapshot["commands"][number];
type Item = Readonly<{command: Command; binding: Binding}>;

const scopeLabels: Record<string, string> = {
  [shortcutScopeIds.application]: "应用内",
  [shortcutScopeIds.workbench]: "工作台",
  [shortcutScopeIds.document]: "当前文稿",
  [shortcutScopeIds.projectTree]: "工程文件树（文件或文件夹获得焦点时）",
};

function ShortcutRow({item, editing, busy, model, onEdit, onClose}: {
  item: Item;
  editing: boolean;
  busy: boolean;
  model: ShortcutSettingsModel;
  onEdit(): void;
  onClose(): void;
}) {
  const {command, binding} = item;
  const [draft, setDraft] = useState<string | null>(null);
  const [inputError, setInputError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const hintId = useId();
  const mac = isMacPlatform();

  useEffect(() => {
    if (editing) input.current?.focus();
    else if (restoreFocus.current) { restoreFocus.current = false; editButton.current?.focus(); }
  }, [editing]);

  function startEditing() {
    setDraft(null);
    setInputError("");
    onEdit();
  }
  function closeEditor() { model.clearFailure(binding.id); restoreFocus.current = true; onClose(); }
  function save() {
    if (!draft || busy) return;
    void model.set(binding.id, draft).then(saved => { if (saved) closeEditor(); });
  }
  function record(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.getModifierState("AltGraph")) return;
    const hasModifier = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
    if (event.key === "Tab" && !hasModifier) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === "Enter" && !hasModifier && draft) { save(); return; }
    try {
      const chord = shortcutFromKeyEvent(event.nativeEvent, mac);
      if (chord) { setDraft(chord); setInputError(""); }
    } catch {
      setDraft(null);
      setInputError("请使用带修饰键的有效组合，或 F1–F24 功能键。");
    }
  }

  return <li className="shortcut-settings-row" onKeyDownCapture={event => {
    if (editing && !busy && event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      closeEditor();
    }
  }}>
    <div className="shortcut-settings-row-main">
      <div className="shortcut-settings-name">
        <span>{command.title}</span>
        <span className="shortcut-settings-scope">{scopeLabels[binding.scopeId] ?? "插件范围"}</span>
      </div>
      <div className="shortcut-settings-current">
        <kbd className="shortcut-settings-key">{binding.label || "未设置"}</kbd>
        <Button ref={editButton} variant="ghost" disabled={busy} aria-label={`修改${command.title}的快捷键`} onClick={startEditing}>修改</Button>
      </div>
    </div>
    {binding.conflicted && <p className="shortcut-settings-warning">此快捷键存在冲突，暂时不会生效。</p>}
    {editing && <div className="shortcut-settings-editor">
      <div className="shortcut-settings-editor-controls">
        <TextField ref={input} readOnly value={draft ? formatShortcut(draft, mac) : ""}
          aria-label={`${command.title}的新快捷键`} aria-describedby={hintId} aria-invalid={!!inputError}
          placeholder="按下新的组合键" onKeyDown={record}/>
        <Button variant="primary" disabled={!draft || busy} onClick={save}>保存</Button>
        <Button variant="ghost" disabled={busy} onClick={closeEditor}>取消</Button>
      </div>
      <p className="shortcut-settings-hint" id={hintId}>按下组合键录入，Esc 取消。默认：{binding.defaultLabel}</p>
      {inputError && <p className="shortcut-settings-warning" role="alert">{inputError}</p>}
      <div className="shortcut-settings-editor-actions">
        <Button variant="ghost" disabled={busy || !binding.keys} onClick={() => {
          void model.set(binding.id, null).then(saved => { if (saved) closeEditor(); });
        }}>清除快捷键</Button>
        <Button variant="ghost" disabled={busy || !binding.customized} onClick={() => {
          void model.reset(binding.id).then(saved => { if (saved) closeEditor(); });
        }}>恢复默认</Button>
      </div>
    </div>}
  </li>;
}

export function ShortcutSettings({shortcuts, model}: {shortcuts: ShortcutsService; model: ShortcutSettingsModel}) {
  const subscribe = useCallback((listener: () => void) => shortcuts.subscribe(listener), [shortcuts]);
  const getSnapshot = useCallback(() => shortcuts.getSnapshot(), [shortcuts]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const commands = new Map(snapshot.commands.map(command => [command.id, command]));
  const items: Item[] = snapshot.bindings.flatMap(binding => {
    const command = commands.get(binding.commandId);
    return command ? [{command, binding}] : [];
  });
  const searchText = (value: string) => value.toLocaleLowerCase().replace(/[\s+]+/g, "");
  const queryText = searchText(query.trim());
  const visible = items.filter(({command, binding}) => !queryText || [command.title, command.category, binding.label,
    binding.keys ?? "", binding.defaultLabel, scopeLabels[binding.scopeId] ?? "插件范围"]
    .some(value => searchText(value).includes(queryText)));
  const groups = new Map<string, Item[]>();
  for (const item of visible) {
    const group = groups.get(item.command.category) ?? [];
    group.push(item);
    groups.set(item.command.category, group);
  }
  const titleFor = (id: string) => items.find(item => item.binding.id === id)?.command.title;
  const busy = state.pendingId !== null;

  return <div className="shortcut-settings">
    <p className="shortcut-settings-description">查看和修改应用快捷键。编辑器内的快捷键由编辑器处理。</p>
    <SearchField label="搜索快捷键" placeholder="搜索操作或快捷键" value={query} onChange={event => setQuery(event.target.value)}/>
    {busy && <p className="shortcut-settings-status" role="status">正在保存快捷键…</p>}
    {state.failures.map(failure => {
      const name = titleFor(failure.action.bindingId) ?? "此操作";
      const conflicts = failure.conflictingBindingIds.map(titleFor).filter((title): title is string => !!title);
      return <div className="shortcut-settings-failure" role="alert" key={failure.action.bindingId}>
        <p>{failure.kind === "conflict"
          ? `「${name}」的快捷键与${conflicts.length ? `「${conflicts.join("」「")}」` : "同一范围内的其他操作"}冲突，请换一个组合。`
          : `「${name}」的快捷键未能保存，原设置仍然有效。`}</p>
        {failure.kind === "save" && <Button variant="ghost" disabled={busy} onClick={() => { void model.retry(failure.action.bindingId); }}>重试</Button>}
      </div>;
    })}
    {!visible.length && <p className="shortcut-settings-empty">{queryText ? "没有找到匹配的快捷键。" : "暂无可设置的快捷键。"}</p>}
    {[...groups].map(([category, group]) => <section className="shortcut-settings-group" key={category} aria-label={`${category}快捷键`}>
      <h3>{category}</h3>
      <ul>{group.map(item => <ShortcutRow key={item.binding.id} item={item} editing={editingId === item.binding.id}
        busy={busy} model={model} onEdit={() => setEditingId(item.binding.id)} onClose={() => setEditingId(null)}/>)}</ul>
    </section>)}
  </div>;
}
