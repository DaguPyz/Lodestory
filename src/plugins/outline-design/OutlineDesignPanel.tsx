import {useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent} from "react";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import type {ContextMenuService} from "@lodestory/sdk/context-menu";
import type {TimelineListModel, TimelineService} from "@lodestory/sdk/timeline";
import {Button, Dialog, DialogActions, Icon, TextField} from "@lodestory/ui";

function TimelineList({contextMenus, model, active, onOpenTimeline}: {
  contextMenus: ContextMenuService;
  model: TimelineListModel;
  active: boolean;
  onOpenTimeline(id: string): boolean;
}) {
  const MenuRegion = contextMenus.Region;
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [creating, setCreating] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const listSurface = useRef<HTMLDivElement>(null);
  const selectedEntry = useRef<HTMLButtonElement>(null);
  const restoreListFocus = useRef(false);
  const draft = snapshot.createDraft;
  const titleLength = [...(draft?.title.trim() ?? "")].length;
  const summaryLength = [...(draft?.summary ?? "")].length;

  useLayoutEffect(() => {
    selectedEntry.current?.scrollIntoView({block: "nearest"});
    if (active && restoreListFocus.current && !snapshot.busy) {
      restoreListFocus.current = false;
      (selectedEntry.current ?? listSurface.current)?.focus();
    }
  }, [active, snapshot.busy, snapshot.selectedId, snapshot.entries]);

  useLayoutEffect(() => {
    if (!active) setCreating(false);
  }, [active]);

  function createTimeline() {
    if (!active || snapshot.busy) return;
    if (model.beginCreate()) setCreating(true);
  }

  async function deleteTimeline(id: string) {
    if (!active || snapshot.busy) return;
    restoreListFocus.current = true;
    await model.remove(id);
  }

  function selectTimeline(id: string) {
    if (!active || snapshot.busy) return;
    onOpenTimeline(id);
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!active || !draft || titleLength < 1 || titleLength > 60 || summaryLength > 200 || snapshot.busy) return;
    if (await model.create()) {
      setCreating(false);
      const selectedId = model.getSnapshot().selectedId;
      if (selectedId) onOpenTimeline(selectedId);
    }
  }

  const hasProblem = Boolean(snapshot.error) || snapshot.issues.length > 0;
  const canShowEmpty = snapshot.loaded && !snapshot.loading && snapshot.entries.length === 0 && !hasProblem;

  return <>
    <MenuRegion label="时间线列表操作" disabled={!active || snapshot.busy} items={[
      {id: "new", label: "新建", icon: <Icon name="plus"/>, restoreFocus: false, onSelect: createTimeline},
    ]}>
    <div className="outline-design-list-scroll" ref={listSurface} tabIndex={0} aria-label="时间线列表">
      {snapshot.loading && <p className="outline-design-list-status" role="status">正在读取时间线…</p>}
      {hasProblem && <div className="outline-design-list-status" role="alert">
        <p>{snapshot.error ?? "有时间线文件无法读取，已保留原文件。"}</p>
        {snapshot.issues.map((issue, index) => <p key={`${issue.name}:${index}`}>{issue.name}：{issue.message}</p>)}
        <Button onClick={async () => {
          if (await model.retry() && !model.getSnapshot().createDraft) setCreating(false);
        }} disabled={snapshot.retryDisabled}>{snapshot.retryLabel}</Button>
      </div>}
      <ul className="outline-design-list" aria-label="时间线梳理">
        {snapshot.entries.map(timeline => <li key={timeline.id}>
          <MenuRegion context={timeline.id} label={`${timeline.title}时间线操作`} disabled={!active || snapshot.busy}
            fallbackFocus={() => selectedEntry.current ?? listSurface.current} items={[
              {id: "new", label: "新建", icon: <Icon name="plus"/>, restoreFocus: false, onSelect: createTimeline},
              {id: "delete", label: "删除", restoreFocus: false, onSelect: deleteTimeline},
            ]}>
          <button type="button" className="outline-design-entry" aria-pressed={snapshot.selectedId === timeline.id}
            ref={snapshot.selectedId === timeline.id ? selectedEntry : undefined}
            onClick={() => selectTimeline(timeline.id)}>
            <span className="outline-design-entry-heading">
              <strong>{timeline.title}</strong>
              {snapshot.selectedId === timeline.id && <Icon name="check" size="small"/>}
            </span>
            <span className="outline-design-entry-summary" title={timeline.summary}>
              {timeline.summary || "还没有梗概，故事从这里开始。"}
            </span>
            <span className="outline-design-entry-meta">
              <span>{timeline.period || "时间待定"}</span>
              <span>{timeline.eventCount} 个事件</span>
            </span>
          </button>
          </MenuRegion>
          {timeline.saveState === "error" && <div className="outline-design-entry-save-error">
            <span>{timeline.saveError || "保存失败"}</span>
            <Button onClick={() => void model.save(timeline.id)} disabled={snapshot.busy}>重试保存</Button>
          </div>}
        </li>)}
      </ul>
      {canShowEmpty && <div className="outline-design-list-empty">
        <p>还没有时间线。</p>
        <Button onClick={createTimeline} disabled={!active || snapshot.busy}>新建时间线</Button>
      </div>}
    </div>
    </MenuRegion>
    <Dialog open={creating && active} onOpenChange={open => {
      if (open) setCreating(true);
      else if (!snapshot.creating) {
        model.cancelCreate();
        setCreating(false);
      }
    }} title="新建时间线" size="narrow" busy={snapshot.creating}
      description="围绕一条故事线，梳理它的起点、经过与结局。创建未完成时，请先完成或取消再切换项目。" initialFocus={nameInput} finalFocus={listSurface}>
      <form className="outline-design-form" onSubmit={event => void submitCreate(event)}>
        <label className="outline-design-field"><span>时间线名称</span>
          <TextField ref={nameInput} value={draft?.title ?? ""} disabled={snapshot.creating}
            onChange={event => model.updateCreateDraft({title: event.target.value})}
            placeholder="输入时间线名称" required autoComplete="off" aria-invalid={titleLength > 60}/>
          <span className="outline-design-field-count">{titleLength} / 60</span>
        </label>
        <label className="outline-design-field"><span>故事梗概 <span className="outline-design-optional">（选填）</span></span>
          <TextField value={draft?.summary ?? ""} disabled={snapshot.creating} onChange={event => model.updateCreateDraft({summary: event.target.value})}
            placeholder="这条故事线讲述了什么？" aria-invalid={summaryLength > 200}/>
          <span className="outline-design-field-count">{summaryLength} / 200</span>
        </label>
        {snapshot.error && <div className="outline-design-list-status" role="alert">
          <p>{snapshot.error}</p>
          <Button onClick={async () => {
            if (await model.retry()) setCreating(false);
          }} disabled={snapshot.retryDisabled}>{snapshot.retryLabel}</Button>
        </div>}
        <DialogActions>
          <Button type="button" onClick={() => { model.cancelCreate(); setCreating(false); }} disabled={snapshot.creating}>取消</Button>
          <Button type="submit" variant="primary" disabled={!draft || !titleLength || titleLength > 60 || summaryLength > 200 || snapshot.busy}>
            {snapshot.creating ? "正在创建…" : "创建时间线"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  </>;
}

export function OutlineDesignPanel({workbench, contextMenus, timelines, active}: {
  workbench: WorkbenchService;
  contextMenus: ContextMenuService;
  timelines: TimelineService;
  active: boolean;
}) {
  const snapshot = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const session = snapshot.session;
  const model = session ? timelines.getModel(session.id) : undefined;

  return <div className="outline-design-panel">
    {session && model
      ? <TimelineList key={session.id} contextMenus={contextMenus} model={model} active={active}
          onOpenTimeline={timelineId => timelines.open(session.id, timelineId)}/>
      : session
        ? <p className="outline-design-empty" role="status">正在准备时间线列表…</p>
        : <p className="outline-design-empty" role="status">请先打开一个项目。</p>}
  </div>;
}
