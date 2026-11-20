import type {I18nService, Translate} from "@lodestory/sdk/i18n";
import {useTranslation} from "../../utils/useTranslation";
import {useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent} from "react";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import type {ContextMenuService} from "@lodestory/sdk/context-menu";
import type {TimelineListModel, TimelineService} from "@lodestory/sdk/timeline";
import {Button, Dialog, DialogActions, Icon, TextField} from "@lodestory/ui";

function TimelineList({t, contextMenus, model, active, onOpenTimeline}: {
  t: Translate;
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
    <MenuRegion label={t("时间线列表操作")} disabled={!active || snapshot.busy} items={[
      {id: "new", label: t("新建"), icon: <Icon name="plus"/>, restoreFocus: false, onSelect: createTimeline},
    ]}>
    <div className="outline-design-list-scroll" ref={listSurface} tabIndex={0} aria-label={t("时间线列表")}>
      {snapshot.loading && <p className="outline-design-list-status" role="status">{t("正在读取时间线…")}</p>}
      {hasProblem && <div className="outline-design-list-status" role="alert">
        <p>{snapshot.error ?? t("有时间线文件无法读取，已保留原文件。")}</p>
        {snapshot.issues.map((issue, index) => <p key={`${issue.name}:${index}`}>{issue.name}：{issue.message}</p>)}
        <Button variant="ghost" onClick={async () => {
          if (await model.retry() && !model.getSnapshot().createDraft) setCreating(false);
        }} disabled={snapshot.retryDisabled}>{t(snapshot.retryLabel)}</Button>
      </div>}
      <ul className="outline-design-list" aria-label={t("时间线梳理")}>
        {snapshot.entries.map(timeline => <li key={timeline.id}>
          <MenuRegion context={timeline.id} label={t("{title}时间线操作", {values: {title: timeline.title}})} disabled={!active || snapshot.busy}
            fallbackFocus={() => selectedEntry.current ?? listSurface.current} items={[
              {id: "new", label: t("新建"), icon: <Icon name="plus"/>, restoreFocus: false, onSelect: createTimeline},
              {id: "delete", label: t("删除"), restoreFocus: false, onSelect: deleteTimeline},
            ]}>
          <button type="button" className="outline-design-entry" aria-pressed={snapshot.selectedId === timeline.id}
            ref={snapshot.selectedId === timeline.id ? selectedEntry : undefined}
            onClick={() => selectTimeline(timeline.id)}>
            <span className="outline-design-entry-heading">
              <strong>{timeline.title}</strong>
              <span className="outline-design-entry-count">{t("{count} 个事件", {count: timeline.eventCount, values: {count: timeline.eventCount}})}</span>
            </span>
            <span className="outline-design-entry-meta">
              <span className="outline-design-entry-summary" title={timeline.summary}>
                {timeline.summary || t("还没有梗概，故事从这里开始。")}
              </span>
              <span className="outline-design-entry-period" title={timeline.period.replace(/ 天$/, () => ` ${t("天")}`) || t("时间待定")}>
                {timeline.period.replace(/ 天$/, () => ` ${t("天")}`) || t("时间待定")}
              </span>
            </span>
          </button>
          </MenuRegion>
          {timeline.saveState === "error" && <div className="outline-design-entry-save-error">
            <span>{t(timeline.saveError || "保存失败")}</span>
            <Button variant="ghost" onClick={() => void model.save(timeline.id)} disabled={snapshot.busy}>{t("重试保存")}</Button>
          </div>}
        </li>)}
      </ul>
      {canShowEmpty && <div className="outline-design-list-empty">
        <p>{t("还没有时间线。")}</p>
        <Button variant="primary" onClick={createTimeline} disabled={!active || snapshot.busy}>{t("新建时间线")}</Button>
      </div>}
    </div>
    </MenuRegion>
    <Dialog open={creating && active} onOpenChange={open => {
      if (open) setCreating(true);
      else if (!snapshot.creating) {
        model.cancelCreate();
        setCreating(false);
      }
    }} title={t("新建时间线")} size="narrow" busy={snapshot.creating}
      description={t("围绕一条故事线，梳理它的起点、经过与结局。创建未完成时，请先完成或取消再切换项目。")} initialFocus={nameInput} finalFocus={listSurface}>
      <form className="outline-design-form" onSubmit={event => void submitCreate(event)}>
        <label className="outline-design-field"><span>{t("时间线名称")}</span>
          <TextField ref={nameInput} value={draft?.title ?? ""} disabled={snapshot.creating}
            onChange={event => model.updateCreateDraft({title: event.target.value})}
            placeholder={t("输入时间线名称")} required autoComplete="off" aria-invalid={titleLength > 60}/>
          <span className="outline-design-field-count">{titleLength} / 60</span>
        </label>
        <label className="outline-design-field"><span>{t("故事梗概")}<span className="outline-design-optional">{t("（选填）")}</span></span>
          <TextField value={draft?.summary ?? ""} disabled={snapshot.creating} onChange={event => model.updateCreateDraft({summary: event.target.value})}
            placeholder={t("这条故事线讲述了什么？")} aria-invalid={summaryLength > 200}/>
          <span className="outline-design-field-count">{summaryLength} / 200</span>
        </label>
        {snapshot.error && <div className="outline-design-list-status" role="alert">
          <p>{t(snapshot.error)}</p>
          <Button variant="ghost" onClick={async () => {
            if (await model.retry()) setCreating(false);
          }} disabled={snapshot.retryDisabled}>{t(snapshot.retryLabel)}</Button>
        </div>}
        <DialogActions>
          <Button variant="secondary" type="button" onClick={() => { model.cancelCreate(); setCreating(false); }} disabled={snapshot.creating}>{t("取消")}</Button>
          <Button type="submit" variant="primary" disabled={!draft || !titleLength || titleLength > 60 || summaryLength > 200 || snapshot.busy}>
            {snapshot.creating ? t("正在创建…") : t("创建时间线")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  </>;
}

export function OutlineDesignPanel({i18n, workbench, contextMenus, timelines, active}: {
  i18n: I18nService;
  workbench: WorkbenchService;
  contextMenus: ContextMenuService;
  timelines: TimelineService;
  active: boolean;
}) {
  const snapshot = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const t = useTranslation(i18n);
  const session = snapshot.session;
  const model = session ? timelines.getModel(session.id) : undefined;

  return <div className="outline-design-panel">
    {session && model
      ? <TimelineList t={t} key={session.id} contextMenus={contextMenus} model={model} active={active}
          onOpenTimeline={timelineId => timelines.open(session.id, timelineId)}/>
      : session
        ? <p className="outline-design-empty" role="status">{t("正在准备时间线列表…")}</p>
        : <p className="outline-design-empty" role="status">{t("请先打开一个项目。")}</p>}
  </div>;
}
