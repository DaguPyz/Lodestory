import type {Plugin} from "@lodestory/sdk";
import {documentCreateRequested, documentRevealRequested, documentsKey} from "@lodestory/sdk/documents";
import {layoutKey, type LayoutContent} from "@lodestory/sdk/layout";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {bodyEditorDefaultEditorsConfig, bodyEditorKey, type EditorFormat} from "@lodestory/sdk/body-editor";
import {configKey} from "@lodestory/sdk/config";
import {uiKey} from "@lodestory/sdk/ui";
import {BodyEditorContentProvider} from "./BodyEditorContext";
import {BodyEditor} from "./BodyEditorView";
import {bodyEditorContentIds} from "./bodyEditorContentIds";
import {createBodyEditorModel, type BodyEditorModel} from "./bodyEditorModel";
import {createBodyEditorRegistry} from "./bodyEditorRegistry";

/** 文稿正文与焦点恢复的独立提供者，不拥有文档工作区。 */
export function createBodyEditorPlugin(): Plugin {
  const models = new Map<string, BodyEditorModel>();
  const removeContents: (() => void)[] = [];
  let removeParticipant: (() => Promise<void>) | undefined;
  let registry: ReturnType<typeof createBodyEditorRegistry> | undefined;
  let removeRegistryUiWrapper: (() => void) | undefined;
  let removeConfig: (() => void) | undefined;
  return {
    id: "body-editor",
    requires: [workbenchKey, documentsKey, layoutKey, uiKey, configKey],
    provides: [bodyEditorKey],
    activate(context) {
      const workbench = context.get(workbenchKey);
      const documents = context.get(documentsKey);
      const layout = context.get(layoutKey);
      const ui = context.get(uiKey);
      const config = context.get(configKey);
      removeConfig = config.register(bodyEditorDefaultEditorsConfig);
      const defaults = config.getSnapshot(bodyEditorDefaultEditorsConfig);
      const editorRegistry = createBodyEditorRegistry(defaults, () => {
        const remove = removeRegistryUiWrapper;
        removeRegistryUiWrapper = undefined;
        remove?.();
      }, (sessionId, target) => models.get(sessionId)?.revealSearchTarget(target) ?? false);
      registry = editorRegistry;
      context.provide(bodyEditorKey, editorRegistry.service);
      removeRegistryUiWrapper = context.track(ui.addWrapper({
        id: "body-editor-registry",
        order: 20,
        prepare: editorRegistry.start,
        wrap: children => children,
      }));
      const resolveEditor = (format: EditorFormat) => editorRegistry.resolve(format);
      removeContents.push(context.on(documentRevealRequested, request => {
        const session = workbench.getSnapshot().session;
        if (!session || session.id !== request.sessionId) return;
        models.get(session.id)?.revealDocument(request.documentId);
      }));
      removeParticipant = context.track(workbench.registerParticipant({
        id: "body-editor",
        label: "编辑器",
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
      }));
      const contents: LayoutContent[] = [
        {id: bodyEditorContentIds.main, title: "正文编辑", role: "main", render: props => <BodyEditor {...props}/>},
      ];
      for (const content of contents) {
        removeContents.push(context.track(layout.registerContent({...content, render: props =>
          <BodyEditorContentProvider workbench={workbench} models={models} resolveEditor={resolveEditor}>
            {content.render(props)}
          </BodyEditorContentProvider>})));
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
      const stopRegistryUi = removeRegistryUiWrapper;
      removeRegistryUiWrapper = undefined;
      try { stopRegistryUi?.(); } catch (error) { errors.push(error); }
      const activeRegistry = registry;
      registry = undefined;
      try { activeRegistry?.dispose(); } catch (error) { errors.push(error); }
      const removeEditorConfig = removeConfig;
      removeConfig = undefined;
      try { removeEditorConfig?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw Object.assign(new Error("Body editor failed to stop."), {errors});
    },
  };
}
