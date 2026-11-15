import {useSyncExternalStore} from "react";
import type {Plugin} from "@lodestory/sdk";
import {canvasKey, type CanvasService} from "@lodestory/sdk/canvas";
import {contextMenuKey, type ContextMenuService} from "@lodestory/sdk/context-menu";
import {assetCatalogKey, type AssetCatalogService} from "@lodestory/sdk/asset-catalog";
import {layoutKey} from "@lodestory/sdk/layout";
import {workbenchKey, type WorkbenchService} from "@lodestory/sdk/workbench";
import {projectStorageKey, type ProjectFiles} from "@lodestory/sdk/project-storage";
import {timelineKey, type TimelineListEntry, type TimelineListModel, type TimelineListSnapshot, type TimelineService} from "@lodestory/sdk/timeline";
import {projectSearchKey, type ProjectSearchRecord} from "@lodestory/sdk/project-search";
import {createTimelineListFiles} from "./timelineListFiles";
import {createTimelineListModel} from "./timelineListModel";
import {createTimelineAxisStore, type TimelineAxisSettings, type TimelineAxisStore} from "./timelineAxisStore";
import {createTimelineEventStore, type TimelineEvent, type TimelineEventStore} from "./timelineEventStore";
import {timelineValueAtOffset} from "./timelineAxisGeometry";
import {createTimelineCanvasView, TimelineCanvas} from "./TimelineCanvas";
import "./timeline.css";

const MAIN_CONTENT_ID = "timeline.main";

type TimelineEntrySummary = {
  events: readonly TimelineEvent[] | undefined;
  eventsLoaded: boolean;
  settings: TimelineAxisSettings | undefined;
  axisLoaded: boolean;
  entry: TimelineListEntry;
  result: TimelineListEntry;
};

type TimelineModel = ReturnType<typeof createTimelineListModel>;
type TimelineSessionResources = {
  model: TimelineModel;
  publicModel: TimelineListModel;
  views: Map<string, ReturnType<typeof createTimelineCanvasView>>;
  axes: Map<string, TimelineAxisStore>;
  events: Map<string, TimelineEventStore>;
  summaries: Map<string, TimelineEntrySummary>;
  axisUnsubscribes: Map<string, () => void>;
  eventUnsubscribes: Map<string, () => void>;
  editing: Set<string>;
  listeners: Set<() => void>;
  snapshot: TimelineListSnapshot;
  unsubscribe: () => void;
  selectedId: string | null;
  openGeneration: number;
  openedId: string | null;
  openListeners: Set<() => void>;
  searchListeners: Set<() => void>;
};

/** Owns timeline metadata, project-session models, canvas viewports, and axis settings. */
export function createTimelinePlugin(): Plugin {
  let alive = true;
  let removeMain: (() => void) | undefined;
  let removeParticipant: (() => Promise<void>) | undefined;
  const sessions = new Map<string, TimelineSessionResources>();

  return {
    id: "timeline",
    requires: [layoutKey, workbenchKey, projectStorageKey, canvasKey, contextMenuKey, assetCatalogKey, projectSearchKey],
    provides: [timelineKey],
    activate(context) {
      alive = true;
      const layout = context.get(layoutKey);
      const workbench = context.get(workbenchKey);
      const storage = context.get(projectStorageKey);
      const canvas = context.get(canvasKey);
      const contextMenus = context.get(contextMenuKey);
      const assetCatalog = context.get(assetCatalogKey);
      const search = context.get(projectSearchKey);

      function createAxis(files: ProjectFiles, resource: TimelineSessionResources, timelineId: string): TimelineAxisStore {
        let axis = resource.axes.get(timelineId);
        if (!axis) {
          axis = createTimelineAxisStore(files, timelineId);
          resource.axes.set(timelineId, axis);
        }
        return axis;
      }

      function publishSession(resource: TimelineSessionResources) {
        const base = resource.model.getSnapshot();
        const nextEntries = base.entries.map(entry => enrichEntry(entry, resource.events.get(entry.id), resource.axes.get(entry.id), resource.summaries));
        const previous = resource.snapshot;
        const entries = nextEntries.length === previous.entries.length && nextEntries.every((entry, index) => entry === previous.entries[index])
          ? previous.entries : Object.freeze(nextEntries);
        const next = Object.freeze({...base, entries});
        if (sameListSnapshot(previous, next)) return;
        resource.snapshot = next;
        for (const listener of [...resource.listeners]) listener();
      }

      function createEvents(files: ProjectFiles, resource: TimelineSessionResources, timelineId: string): TimelineEventStore {
        let events = resource.events.get(timelineId);
        if (!events) {
          events = createTimelineEventStore(files, timelineId);
          resource.events.set(timelineId, events);
          let previous = events.getSnapshot();
          resource.eventUnsubscribes.set(timelineId, events.subscribe(() => {
            publishSession(resource);
            const next = events!.getSnapshot();
            if (next.events !== previous.events || next.loading !== previous.loading || next.loaded !== previous.loaded || next.error !== previous.error)
              for (const listener of [...resource.searchListeners]) listener();
            previous = next;
          }));
          void events.load().catch(() => false);
        }
        return events;
      }

      function ensureView(resource: TimelineSessionResources, timelineId: string) {
        if (!resource.views.has(timelineId)) {
          resource.views.set(timelineId, createTimelineCanvasView(canvas.createViewport()));
        }
      }

      function syncResources(files: ProjectFiles, resource: TimelineSessionResources) {
        const snapshot = resource.model.getSnapshot();
        const present = new Set(snapshot.entries.map(entry => entry.id));
        for (const timelineId of resource.summaries.keys()) {
          if (!present.has(timelineId)) resource.summaries.delete(timelineId);
        }
        for (const [timelineId, view] of resource.views) {
          if (present.has(timelineId)) continue;
          resource.views.delete(timelineId);
          view.dispose();
        }
        for (const [timelineId, axis] of resource.axes) {
          if (present.has(timelineId)) continue;
          resource.axes.delete(timelineId);
          resource.editing.delete(timelineId);
          resource.axisUnsubscribes.get(timelineId)?.();
          resource.axisUnsubscribes.delete(timelineId);
          axis.dispose();
        }
        for (const [timelineId, events] of resource.events) {
          if (present.has(timelineId)) continue;
          resource.events.delete(timelineId);
          resource.eventUnsubscribes.get(timelineId)?.();
          resource.eventUnsubscribes.delete(timelineId);
          events.dispose();
        }
        for (const entry of snapshot.entries) {
          let axis = resource.axes.get(entry.id);
          if (!axis) {
            axis = createAxis(files, resource, entry.id);
            resource.axisUnsubscribes.set(entry.id, axis.subscribe(() => publishSession(resource)));
            void axis.load().catch(() => false);
          }
          createEvents(files, resource, entry.id);
        }

        const selectionChanged = resource.selectedId !== snapshot.selectedId;
        resource.selectedId = snapshot.selectedId;
        if (snapshot.selectedId) {
          ensureView(resource, snapshot.selectedId);
          const axis = createAxis(files, resource, snapshot.selectedId);
          if (selectionChanged && !axis.getSnapshot().loaded && !axis.getSnapshot().loading) void axis.load().catch(() => false);
        }
        publishSession(resource);
        for (const listener of [...resource.searchListeners]) listener();
      }

      removeParticipant = context.track(workbench.registerParticipant({
        id: "timeline",
        label: "大纲时间线",
        async start(session) {
          if (!alive || sessions.has(session.id)) throw new Error(`Timeline session '${session.id}' cannot be started.`);
          const files = storage.getFiles(session.id);
          if (!files) throw new Error(`Project storage for session '${session.id}' is unavailable.`);
          const model = createTimelineListModel(createTimelineListFiles(files));
          const resource: TimelineSessionResources = {
            model,
            publicModel: undefined as unknown as TimelineListModel,
            views: new Map(),
            axes: new Map(),
            events: new Map(),
            summaries: new Map(),
            axisUnsubscribes: new Map(),
            eventUnsubscribes: new Map(),
            editing: new Set(),
            listeners: new Set(),
            snapshot: model.getSnapshot(),
            unsubscribe: () => {},
            selectedId: null,
            openGeneration: 0,
            openedId: null,
            openListeners: new Set(),
            searchListeners: new Set(),
          };
          let removeSearch: (() => void) | undefined;
          const canMutate = () => {
            if (!alive || sessions.get(session.id) !== resource) return false;
            const current = workbench.getSnapshot();
            return current.session?.id === session.id && current.active && !current.busy;
          };
          resource.publicModel = Object.freeze({
            getSnapshot() { return resource.snapshot; },
            subscribe(listener: () => void) {
              resource.listeners.add(listener);
              return () => { resource.listeners.delete(listener); };
            },
            beginCreate() { return canMutate() && resource.editing.size === 0 ? model.beginCreate() : null; },
            updateCreateDraft(values) { if (canMutate() && resource.editing.size === 0) model.updateCreateDraft(values); },
            cancelCreate: model.cancelCreate,
            create() { return canMutate() && resource.editing.size === 0 ? model.create() : Promise.resolve(false); },
            async remove(id) {
              if (!canMutate() || resource.editing.size > 0) return false;
              const axis = resource.axes.get(id);
              const events = resource.events.get(id);
              if (axis?.getSnapshot().dirty) {
                if (!await axis.retry()) return false;
                if (!canMutate() || resource.editing.size > 0 || axis.getSnapshot().dirty) return false;
              }
              if (events?.getSnapshot().dirty) {
                if (!await events.retry()) return false;
                if (!canMutate() || resource.editing.size > 0 || events.getSnapshot().dirty) return false;
              }
              if (!canMutate() || resource.editing.size > 0 || axis?.getSnapshot().dirty || events?.getSnapshot().dirty) return false;
              return model.remove(id);
            },
            save(id) { return canMutate() && resource.editing.size === 0 ? model.save(id) : Promise.resolve(false); },
            retry() { return canMutate() && resource.editing.size === 0 ? model.retry() : Promise.resolve(false); },
          });
          resource.unsubscribe = model.subscribe(() => syncResources(files, resource));
          try {
            const loaded = await model.load();
            if (!loaded) throw new Error(model.getSnapshot().error ?? "时间线数据加载失败。");
            if (!alive) throw new Error("Timeline stopped while the project was loading.");
            // The public model becomes visible only after its initial read settles.
            sessions.set(session.id, resource);
            removeSearch = search.registerSource(session.id, "timeline", {
              title: "时间线",
              getSnapshot() {
                const state = model.getSnapshot();
                const records: ProjectSearchRecord[] = [];
                const issues = [...state.issues.map(issue => `${issue.name}：${issue.message}`)];
                let loading = state.loading;
                for (const entry of state.entries) {
                  records.push({id: `timeline:${entry.id}`, kind: "时间线", title: entry.title, detail: entry.summary, text: ""});
                  const events = resource.events.get(entry.id)?.getSnapshot();
                  if (!events) { loading = true; continue; }
                  if (events.loading || (!events.loaded && !events.error)) loading = true;
                  if (events.error) issues.push(`${entry.title}：${events.error}`);
                  for (const event of events.events) records.push({id: `event:${entry.id}/${event.id}`, kind: "事件",
                    title: event.title, detail: [entry.title, event.summary].filter(Boolean).join(" · "), text: event.summary});
                }
                return {records, loading, error: state.error ?? (issues.length ? issues.join("；") : null)};
              },
              subscribe(listener) { resource.searchListeners.add(listener); return () => { resource.searchListeners.delete(listener); }; },
              open(id) {
                const timelineId = id.startsWith("timeline:") ? id.slice("timeline:".length)
                  : id.startsWith("event:") ? id.slice("event:".length).split("/")[0] : "";
                if (id.startsWith("event:")) {
                  const eventId = id.slice("event:".length).split("/")[1];
                  if (!resource.events.get(timelineId)?.getSnapshot().events.some(event => event.id === eventId)) return false;
                }
                return service.open(session.id, timelineId);
              },
            });
          } catch (error) {
            removeSearch?.();
            resource.unsubscribe();
            for (const view of resource.views.values()) view.dispose();
            for (const unsubscribe of resource.axisUnsubscribes.values()) unsubscribe();
            for (const axis of resource.axes.values()) axis.dispose();
            for (const unsubscribe of resource.eventUnsubscribes.values()) unsubscribe();
            for (const events of resource.events.values()) events.dispose();
            resource.summaries.clear();
            resource.listeners.clear();
            resource.openListeners.clear();
            resource.searchListeners.clear();
            model.dispose();
            if (sessions.get(session.id) === resource) sessions.delete(session.id);
            throw error;
          }
          return {
            async beforeLeave() {
              const canLeave = () => model.getSnapshot().createDraft === null && resource.editing.size === 0;
              if (!canLeave()) return false;
              for (const [id, axis] of resource.axes) {
                if (axis.getSnapshot().dirty) {
                  if (!await axis.retry()) return false;
                  if (!canLeave() || axis.getSnapshot().dirty) return false;
                }
                const events = resource.events.get(id);
                if (events?.getSnapshot().dirty) {
                  if (!await events.retry()) return false;
                  if (!canLeave() || events.getSnapshot().dirty) return false;
                }
                if (!canLeave() || axis.getSnapshot().dirty || events?.getSnapshot().dirty) return false;
              }
              return canLeave()
                && [...resource.axes.values()].every(axis => !axis.getSnapshot().dirty)
                && [...resource.events.values()].every(events => !events.getSnapshot().dirty);
            },
            dispose() {
              try { removeSearch?.(); resource.unsubscribe(); }
              finally {
                try {
                  for (const view of resource.views.values()) view.dispose();
                  resource.views.clear();
                } finally {
                  try {
                    for (const unsubscribe of resource.axisUnsubscribes.values()) unsubscribe();
                    resource.axisUnsubscribes.clear();
                  } finally {
                    try {
                      for (const axis of resource.axes.values()) axis.dispose();
                      resource.axes.clear();
                    } finally {
                      try {
                        for (const unsubscribe of resource.eventUnsubscribes.values()) unsubscribe();
                        resource.eventUnsubscribes.clear();
                      } finally {
                        try {
                          for (const events of resource.events.values()) events.dispose();
                          resource.events.clear();
                          resource.summaries.clear();
                        } finally {
                          try { model.dispose(); }
                          finally {
                            resource.listeners.clear();
                            resource.openListeners.clear();
                            resource.searchListeners.clear();
                            if (sessions.get(session.id) === resource) sessions.delete(session.id);
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
          };
        },
      }));

      const service: TimelineService = {
        getModel(sessionId) { return sessions.get(sessionId)?.publicModel ?? null; },
        open(sessionId, timelineId) {
          const current = workbench.getSnapshot();
          const resource = sessions.get(sessionId);
          const model = resource?.model;
          const snapshot = model?.getSnapshot();
          if (!alive || !resource || !model || !snapshot || current.session?.id !== sessionId
            || !current.active || current.busy || snapshot.busy || snapshot.createDraft
            || !snapshot.entries.some(entry => entry.id === timelineId) || resource.editing.size > 0) return false;
          const opening = resource.openedId !== timelineId || snapshot.selectedId !== timelineId
            || !layout.getSnapshot().shownIds.includes(MAIN_CONTENT_ID);
          model.select(timelineId);
          ensureView(resource, timelineId);
          layout.show(MAIN_CONTENT_ID);
          if (opening) {
            resource.openedId = timelineId;
            resource.openGeneration++;
            for (const listener of [...resource.openListeners]) listener();
          }
          return true;
        },
      };
      context.provide(timelineKey, service);

      removeMain = context.track(layout.registerContent({
        id: MAIN_CONTENT_ID,
        title: "时间线画布",
        role: "main",
        order: 10,
        render: ({active}) => <TimelineMain workbench={workbench} canvas={canvas} contextMenus={contextMenus} assetCatalog={assetCatalog} sessions={sessions} active={active}
          onEditingChange={(sessionId, timelineId, editing) => {
            const resource = sessions.get(sessionId);
            if (!resource || !alive) return;
            if (editing) resource.editing.add(timelineId);
            else resource.editing.delete(timelineId);
          }}/>,
      }));
    },
    async deactivate() {
      alive = false;
      const errors: unknown[] = [];
      const remove = removeMain;
      removeMain = undefined;
      try { remove?.(); } catch (error) { errors.push(error); }
      const unregister = removeParticipant;
      removeParticipant = undefined;
      try { await unregister?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw Object.assign(new Error("Timeline plugin failed to stop."), {errors});
    },
  };
}

function TimelineMain({workbench, canvas, contextMenus, assetCatalog, sessions, active, onEditingChange}: {
  workbench: WorkbenchService;
  canvas: CanvasService;
  contextMenus: ContextMenuService;
  assetCatalog: AssetCatalogService;
  sessions: ReadonlyMap<string, TimelineSessionResources>;
  active: boolean;
  onEditingChange(sessionId: string, timelineId: string, editing: boolean): void;
}) {
  const workbenchSnapshot = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const relationSource = useSyncExternalStore(assetCatalog.relationSource?.subscribe ?? emptySubscribe,
    assetCatalog.relationSource?.getSnapshot ?? noRelations, noRelations);
  const session = workbenchSnapshot.session;
  const resource = session ? sessions.get(session.id) : undefined;
  const subscribe = resource?.publicModel.subscribe ?? emptySubscribe;
  const getSnapshot = resource?.publicModel.getSnapshot ?? emptySnapshot;
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const openGeneration = useSyncExternalStore(
    listener => { resource?.openListeners.add(listener); return () => resource?.openListeners.delete(listener); },
    () => resource?.openGeneration ?? 0,
    () => 0,
  );
  const entry = snapshot.entries.find(item => item.id === snapshot.selectedId);
  const canvasView = entry ? resource?.views.get(entry.id) : undefined;
  const axis = entry ? resource?.axes.get(entry.id) : undefined;
  const events = entry ? resource?.events.get(entry.id) : undefined;
  const current = Boolean(active && session && workbenchSnapshot.active && !workbenchSnapshot.busy
    && !snapshot.busy && !snapshot.createDraft && entry && canvasView && axis && events);
  if (!entry || !canvasView || !axis || !events || !session || !resource) {
    return <div className="timeline-canvas-empty" role="status">选择或新建一条时间线以打开画布。</div>;
  }
  return <TimelineCanvas canvas={canvas} contextMenus={contextMenus} assetCatalog={assetCatalog.getCatalog(session.id)}
    assetRelations={relationSource?.getNetwork(session.id) ?? null} canvasView={canvasView} active={current} title={entry.title} axis={axis} events={events}
    openToken={openGeneration ? `${session.id}:${openGeneration}` : null}
    onEditingChange={editing => onEditingChange(session.id, entry.id, editing)}/>;
}

function emptySubscribe() { return () => {}; }
function noRelations() { return null; }
const EMPTY_SNAPSHOT = Object.freeze({entries: Object.freeze([]), selectedId: null, createDraft: null, issues: Object.freeze([]),
  loaded: false, loading: false, creating: false, busy: true, retryDisabled: true, error: null, retryLabel: "重试读取"});
function emptySnapshot() { return EMPTY_SNAPSHOT; }

function sameListSnapshot(left: TimelineListSnapshot, right: TimelineListSnapshot): boolean {
  return left.entries === right.entries && left.selectedId === right.selectedId && left.createDraft === right.createDraft
    && left.issues === right.issues && left.loaded === right.loaded && left.loading === right.loading
    && left.creating === right.creating && left.busy === right.busy && left.retryDisabled === right.retryDisabled
    && left.error === right.error && left.retryLabel === right.retryLabel;
}

function enrichEntry(entry: TimelineListEntry, eventStore: TimelineEventStore | undefined, axisStore: TimelineAxisStore | undefined,
  cache: Map<string, TimelineEntrySummary>): TimelineListEntry {
  const eventSnapshot = eventStore?.getSnapshot();
  const axisSnapshot = axisStore?.getSnapshot();
  const events = eventSnapshot?.events;
  const eventsLoaded = Boolean(eventSnapshot?.loaded);
  const settings = axisSnapshot?.settings;
  const axisLoaded = Boolean(axisSnapshot?.loaded);
  const previous = cache.get(entry.id);
  const sameInputs = previous && previous.events === events && previous.eventsLoaded === eventsLoaded
    && previous.settings === settings && previous.axisLoaded === axisLoaded;
  if (sameInputs && previous.entry === entry) return previous.result;
  let period = sameInputs ? previous.result.period : "";
  if (!sameInputs && eventsLoaded && axisLoaded && settings && events && events.length > 0) {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const event of events) {
      const value = timelineValueAtOffset(event.offset, settings);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    const start = formatPeriodValue(minimum);
    const end = formatPeriodValue(maximum);
    period = minimum === maximum
      ? `${start} ${settings.unit}`
      : `${start}–${end} ${settings.unit}`;
  }
  const eventCount = events?.length ?? 0;
  const result = previous && previous.entry === entry && previous.result.eventCount === eventCount && previous.result.period === period
    ? previous.result : Object.freeze({...entry, eventCount, period});
  cache.set(entry.id, {events, eventsLoaded, settings, axisLoaded, entry, result});
  return result;
}

function formatPeriodValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Object.is(value, -0) ? "0" : String(value);
}
