import {isTauri} from "@tauri-apps/api/core";
import type {DocumentWorkspace} from "@lodestory/sdk/documents";
import type {LayoutService} from "@lodestory/sdk/layout";
import type {WorkbenchService, WorkbenchSession} from "@lodestory/sdk/workbench";
import {bodyEditorContentIds} from "./bodyEditorContentIds";
import type {EditorSearchTarget} from "@lodestory/sdk/body-editor";

export type BodyEditorSnapshot = Readonly<{
  projectName: string;
  projectPath: string;
  workspace: DocumentWorkspace;
  revealVersion: number;
  searchTarget: EditorSearchTarget | null;
  searchError: string | null;
}>;

export type BodyEditorModel = {
  getSnapshot(): BodyEditorSnapshot;
  subscribe(listener: () => void): () => void;
  requestNewDocument(parentPath?: string): void;
  revealDocument(id: string): boolean;
  revealSearchTarget(target: EditorSearchTarget): boolean;
  finishSearchTarget(target: EditorSearchTarget, success: boolean): void;
  dispose(): void;
};

/** 只持有本会话的编辑展示状态；文档内容和保存始终属于文档服务。 */
export function createBodyEditorModel(
  session: WorkbenchSession,
  workbench: WorkbenchService,
  layout: LayoutService,
  workspace: DocumentWorkspace,
  emitCreateRequest: (parentPath?: string) => Promise<void>,
): BodyEditorModel {
  let disposed = false;
  let snapshot: BodyEditorSnapshot = Object.freeze({
    projectName: session.project.name,
    projectPath: session.project.path,
    workspace,
    revealVersion: 0,
    searchTarget: null,
    searchError: null,
  });
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      const subscription = () => listener();
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
    requestNewDocument(parentPath) {
      const state = workbench.getSnapshot();
      if (disposed || !isTauri() || state.session?.id !== session.id || !state.active || state.busy || workspace.getSnapshot().blocked) return;
      void emitCreateRequest(parentPath).catch(error => console.error("Could not request document creation.", {error}));
    },
    revealDocument(id) {
      if (disposed || workbench.getSnapshot().session?.id !== session.id) return false;
      const state = workspace.getSnapshot();
      if (state.activeId !== id || !state.documents.some(document => document.id === id)) return false;
      // 保存失败可能在离开检查尚未解除 busy/blocked 时发生，仍须展示错误。
      layout.show(bodyEditorContentIds.main);
      snapshot = Object.freeze({...snapshot, revealVersion: snapshot.revealVersion + 1});
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try { listener(); } catch (error) { console.error("Body editor subscriber failed.", {error}); }
      }
      return true;
    },
    revealSearchTarget(target) {
      if (disposed || workbench.getSnapshot().session?.id !== session.id) return false;
      const state = workspace.getSnapshot();
      const document = state.documents.find(item => item.id === target.documentId);
      if (state.activeId !== target.documentId || !document || document.content !== target.content) return false;
      layout.show(bodyEditorContentIds.main);
      snapshot = Object.freeze({...snapshot, searchTarget: target, searchError: null});
      for (const listener of [...listeners]) {
        try { listener(); } catch (error) { console.error("Body editor subscriber failed.", {error}); }
      }
      return true;
    },
    finishSearchTarget(target, success) {
      if (disposed || snapshot.searchTarget !== target) return;
      snapshot = Object.freeze({...snapshot, searchTarget: null,
        searchError: success ? null : "正文已变化或编辑器暂不支持定位，请重新搜索。"});
      for (const listener of [...listeners]) {
        try { listener(); } catch (error) { console.error("Body editor subscriber failed.", {error}); }
      }
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
