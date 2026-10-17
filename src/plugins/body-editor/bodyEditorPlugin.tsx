import type {Plugin} from "@lodestory/sdk";
import {documentCreateRequested, documentRevealRequested, documentsKey} from "@lodestory/sdk/documents";
import {layoutKey, type LayoutContent} from "@lodestory/sdk/layout";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {BodyEditorContentProvider} from "./BodyEditorContext";
import {BodyEditor, WritingStatus} from "./BodyEditorView";
import {bodyEditorContentIds} from "./bodyEditorContentIds";
import {createBodyEditorModel, type BodyEditorModel} from "./bodyEditorModel";

/** 正文、文稿标签与写作状态的独立提供者，不拥有文档工作区。 */
export function createBodyEditorPlugin(): Plugin {
  const models = new Map<string, BodyEditorModel>();
  const removeContents: (() => void)[] = [];
  let removeParticipant: (() => Promise<void>) | undefined;
  return {
    id: "body-editor",
    requires: [workbenchKey, documentsKey, layoutKey],
    provides: [],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const documents = context.get(documentsKey);
      const layout = context.get(layoutKey);
      removeContents.push(context.on(documentRevealRequested, request => {
        const session = workbench.getSnapshot().session;
        if (!session || session.id !== request.sessionId) return;
        models.get(session.id)?.revealDocument(request.documentId);
      }));
      removeParticipant = workbench.registerParticipant({
        id: "body-editor",
        start(session) {
          const workspace = documents.getWorkspace(session.id);
          if (!workspace) throw new Error(`Documents workspace is unavailable for session '${session.id}'.`);
          const model = createBodyEditorModel(session, workbench, layout, workspace, parentPath => context.emit(
            documentCreateRequested,
            parentPath === undefined ? {sessionId: session.id} : {sessionId: session.id, parentPath},
          ));
          models.set(session.id, model);
          return {
            dispose() {
              try { model.dispose(); }
              finally { if (models.get(session.id) === model) models.delete(session.id); }
            },
          };
        },
      });
      const contents: LayoutContent[] = [
        {id: bodyEditorContentIds.main, title: "正文编辑", role: "main", render: props => <BodyEditor {...props}/>},
        {id: bodyEditorContentIds.status, title: "写作状态", role: "status", render: () => <WritingStatus/>},
      ];
      for (const content of contents) {
        removeContents.push(layout.registerContent({...content, render: props =>
          <BodyEditorContentProvider workbench={workbench} models={models}>{content.render(props)}</BodyEditorContentProvider>}));
      }
    },
    async deactivate() {
      const errors: unknown[] = [];
      for (const remove of removeContents.splice(0).reverse()) {
        try { remove(); } catch (error) { errors.push(error); }
      }
      const remove = removeParticipant;
      removeParticipant = undefined;
      try { await remove?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw Object.assign(new Error("Body editor failed to stop."), {errors});
    },
  };
}
