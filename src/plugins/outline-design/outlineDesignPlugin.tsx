import {useSyncExternalStore} from "react";
import type {Plugin} from "@lodestory/sdk";
import {canvasKey, type CanvasService, type CanvasViewport} from "@lodestory/sdk/canvas";
import {layoutKey} from "@lodestory/sdk/layout";
import {workbenchKey, type WorkbenchService} from "@lodestory/sdk/workbench";
import {contextMenuKey} from "@lodestory/sdk/context-menu";
import {projectStorageKey} from "@lodestory/sdk/project-storage";
import {Icon} from "@lodestory/ui";
import {OutlineDesignPanel} from "./OutlineDesignPanel";
import {createTimelineListFiles} from "./timelineListFiles";
import {createTimelineListModel} from "./timelineListModel";
import "./outline-design.css";

/** 大纲列表由本插件管理；本插件定义路径和 UTF-8 JSON 规则，项目存储只管理共享字节。 */
export function createOutlineDesignPlugin(): Plugin {
  const removeContents: (() => void)[] = [];
  let removeParticipant: (() => Promise<void>) | undefined;
  return {
    id: "outline-design",
    requires: [layoutKey, workbenchKey, contextMenuKey, projectStorageKey, canvasKey],
    provides: [],
    activate(context) {
      const layout = context.get(layoutKey);
      const workbench = context.get(workbenchKey);
      const contextMenus = context.get(contextMenuKey);
      const storage = context.get(projectStorageKey);
      const canvas = context.get(canvasKey);
      const models = new Map<string, ReturnType<typeof createTimelineListModel>>();
      const viewports = new Map<string, Map<string, CanvasViewport>>();
      let alive = true;

      function viewportFor(sessionId: string, timelineId: string): CanvasViewport | null {
        if (!alive || !models.has(sessionId)) return null;
        let sessionViewports = viewports.get(sessionId);
        if (!sessionViewports) {
          sessionViewports = new Map();
          viewports.set(sessionId, sessionViewports);
        }
        let viewport = sessionViewports.get(timelineId);
        if (!viewport) {
          viewport = canvas.createViewport();
          sessionViewports.set(timelineId, viewport);
        }
        return viewport;
      }

      function disposeViewports(sessionId: string, keep: ReadonlySet<string> = new Set()) {
        const sessionViewports = viewports.get(sessionId);
        if (!sessionViewports) return;
        for (const [timelineId, viewport] of sessionViewports) {
          if (keep.has(timelineId)) continue;
          sessionViewports.delete(timelineId);
          viewport.dispose();
        }
        if (sessionViewports.size === 0) viewports.delete(sessionId);
      }

      removeParticipant = workbench.registerParticipant({
        id: "outline-design",
        async start(session) {
          if (!alive || models.has(session.id)) throw new Error(`Outline session '${session.id}' cannot be started.`);
          const projectFiles = storage.getFiles(session.id);
          if (!projectFiles) throw new Error(`Project storage for session '${session.id}' is unavailable.`);
          const files = createTimelineListFiles(projectFiles);
          const model = createTimelineListModel(files);
          models.set(session.id, model);
          viewports.set(session.id, new Map());
          const unsubscribe = model.subscribe(() => {
            const state = model.getSnapshot();
            const present = new Set(state.entries.map(entry => entry.id));
            disposeViewports(session.id, present);
            if (state.selectedId) viewportFor(session.id, state.selectedId);
          });
          try {
            await model.load();
          } catch (error) {
            unsubscribe();
            disposeViewports(session.id);
            model.dispose();
            if (models.get(session.id) === model) models.delete(session.id);
            throw error;
          }
          return {
            beforeLeave() {
              // A form draft has no persisted file yet; keep the session alive until it is created or canceled.
              return model.getSnapshot().createDraft === null;
            },
            dispose() {
              try { unsubscribe(); }
              finally {
                try { disposeViewports(session.id); }
                finally {
                  try { model.dispose(); }
                  finally { if (models.get(session.id) === model) models.delete(session.id); }
                }
              }
            },
          };
        },
      });

      removeContents.push(layout.registerContent({
        id: "outline-design.navigation",
        title: "大纲设计",
        role: "navigation",
        order: 10,
        icon: <Icon name="outline"/>,
        render: ({active}) => <OutlineDesignPanel workbench={workbench} contextMenus={contextMenus} models={models}
          onOpenTimeline={(sessionId, timelineId) => {
            const current = workbench.getSnapshot();
            if (!alive || current.session?.id !== sessionId || !current.active || current.busy) return;
            if (!viewportFor(sessionId, timelineId)) return;
            layout.show("outline-design.canvas");
          }}
          active={active}/>,
      }));
      removeContents.push(layout.registerContent({
        id: "outline-design.canvas",
        title: "大纲画布",
        role: "main",
        order: 10,
        render: ({active}) => <OutlineDesignCanvas workbench={workbench} canvas={canvas} models={models} viewports={viewports} active={active}/>,
      }));

      const removeRegisteredContents = removeContents.splice(0);
      removeContents.push(() => {
        alive = false;
        const errors: unknown[] = [];
        for (const remove of removeRegisteredContents.reverse()) {
          try { remove(); } catch (error) { errors.push(error); }
        }
        for (const sessionId of [...viewports.keys()]) {
          try { disposeViewports(sessionId); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw Object.assign(new Error("Outline canvas contributions failed to stop."), {errors});
      });
    },
    async deactivate() {
      const errors: unknown[] = [];
      for (const remove of removeContents.splice(0).reverse()) {
        try { remove(); } catch (error) { errors.push(error); }
      }
      const remove = removeParticipant;
      removeParticipant = undefined;
      try { await remove?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw Object.assign(new Error("Outline design failed to stop."), {errors});
    },
  };
}

function OutlineDesignCanvas({workbench, canvas, models, viewports, active}: {
  workbench: WorkbenchService;
  canvas: CanvasService;
  models: ReadonlyMap<string, ReturnType<typeof createTimelineListModel>>;
  viewports: ReadonlyMap<string, ReadonlyMap<string, CanvasViewport>>;
  active: boolean;
}) {
  const workbenchSnapshot = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const session = workbenchSnapshot.session;
  const model = session ? models.get(session.id) : undefined;
  const subscribe = model ? model.subscribe : emptySubscribe;
  const getSnapshot = model ? model.getSnapshot : emptySnapshot;
  const modelSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const entry = modelSnapshot.entries.find(item => item.id === modelSnapshot.selectedId);
  const viewport = session && entry ? viewports.get(session.id)?.get(entry.id) : undefined;
  const current = Boolean(active && session && workbenchSnapshot.active && !workbenchSnapshot.busy
    && model && !modelSnapshot.busy && !modelSnapshot.createDraft && entry && viewport);
  const Surface = canvas.Surface;

  if (!entry || !viewport) {
    return <div className="outline-design-canvas-empty" role="status">选择或新建一条时间线以打开画布。</div>;
  }

  return <div className="outline-design-canvas">
    <Surface viewport={viewport} active={current} label={entry.title}/>
    <header className="outline-design-canvas-header">
      <h1 title={entry.title}>{entry.title}</h1>
      <p>滚动平移 · ⌘ / Ctrl + 滚动缩放 · 空格或中键拖动</p>
    </header>
  </div>;
}

function emptySubscribe() { return () => {}; }
const EMPTY_CANVAS_SNAPSHOT = Object.freeze({entries: Object.freeze([]), selectedId: null, createDraft: null, issues: Object.freeze([]),
  loaded: false, loading: false, creating: false, busy: true, retryDisabled: true, error: null, retryLabel: "重试读取"});
function emptySnapshot() { return EMPTY_CANVAS_SNAPSHOT; }
