import type {I18nService, Translate} from "@lodestory/sdk/i18n";
import {useTranslation} from "../../utils/useTranslation";
import {useLayoutEffect, useState, useSyncExternalStore} from "react";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import {shortcutCommandIds, type ShortcutsService} from "@lodestory/sdk/shortcuts";
import type {ProjectManagementModel} from "./projectManagementModel";
import {NewDocumentDialog} from "./NewDocumentDialog";
import {DeleteDocumentDialog} from "./DeleteDocumentDialog";
import {RenameEntryDialog} from "./RenameEntryDialog";
import {ProjectTree} from "./ProjectTree";
import "./project-management.css";

type ProjectManagementViewsProps = {
  i18n: I18nService;
  workbench: WorkbenchService;
  models: ReadonlyMap<string, ProjectManagementModel>;
};

function useWorkbench(workbench: WorkbenchService) {
  return useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
}

function ProjectFilesForSession({t, workbench, model, active, shortcuts}: {
  workbench: WorkbenchService;
  t: Translate;
  model: ProjectManagementModel;
  active: boolean;
  shortcuts: ShortcutsService;
}) {
  const workbenchState = useWorkbench(workbench);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const canInteract = active && workbenchState.active && !workbenchState.busy && !snapshot.blocked;
  return <ProjectTree t={t} shortcuts={shortcuts}
    projectName={snapshot.projectName}
    entries={snapshot.entries}
    activeDocumentPath={snapshot.activeDocumentPath}
    openingPath={snapshot.openingPath}
    loading={snapshot.loading}
    error={snapshot.error}
    active={canInteract}
    newDisabled={!canInteract || snapshot.creating || snapshot.loading || snapshot.dialogOpen || !!snapshot.deletePath || snapshot.deleting || !!snapshot.deletingPath || !!snapshot.renamePath || snapshot.renaming}
    deletingPath={snapshot.deletingPath}
    lastRename={snapshot.lastRename}
    onOpenDocument={path => model.openDocument(path)}
    onSelectFolder={path => { model.selectFolder(path); }}
    onNewDocument={parentPath => { void shortcuts.execute(shortcutCommandIds.newDocument,
      {sessionId: snapshot.sessionId, parentPath}).catch(error => console.error("Could not execute new-document command.", error)); }}
    onNewDirectory={parentPath => { model.requestCreateDirectory(parentPath); }}
    onDeleteDocument={path => { model.requestDelete(path); }}
    onRename={path => { void shortcuts.execute(shortcutCommandIds.renameEntry, {sessionId: snapshot.sessionId, path})
      .catch(error => console.error("Could not execute rename command.", error)); }}
    onReload={() => { void model.refresh(); }}
  />;
}

/** Registered as the project's navigation content; layout owns its placement. */
export function ProjectFiles({i18n, workbench, models, shortcuts, active}: ProjectManagementViewsProps & {shortcuts: ShortcutsService; active: boolean}) {
  const workbenchState = useWorkbench(workbench);
  const t = useTranslation(i18n);
  const session = workbenchState.session;
  const model = session ? models.get(session.id) : undefined;
  if (!session || !model) return null;
  return <ProjectFilesForSession t={t} key={session.id} workbench={workbench} model={model} active={active} shortcuts={shortcuts} />;
}

function ProjectDialogsForSession({t, workbench, model}: {t: Translate; workbench: WorkbenchService; model: ProjectManagementModel}) {
  const workbenchState = useWorkbench(workbench);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [closingDeletePath, setClosingDeletePath] = useState(snapshot.deletePath);

  useLayoutEffect(() => {
    if (snapshot.deletePath) setClosingDeletePath(snapshot.deletePath);
  }, [snapshot.deletePath]);

  if (!workbenchState.active) return null;
  return <>
    <RenameEntryDialog t={t}
      open={snapshot.renamePath !== null}
      name={snapshot.renameName}
      suffix={snapshot.renameSuffix}
      directory={snapshot.renameDirectory}
      busy={workbenchState.busy || snapshot.blocked || snapshot.renaming}
      error={snapshot.renameError}
      onClose={() => { model.closeRenameDialog(); }}
      onRename={name => model.rename(name)}
    />
    <DeleteDocumentDialog t={t}
      open={snapshot.deletePath !== null}
      path={snapshot.deletePath ?? closingDeletePath ?? ""}
      busy={workbenchState.busy || snapshot.blocked || snapshot.deleting || !!snapshot.deletingPath}
      error={snapshot.deleteError}
      onClose={() => { model.closeDeleteDialog(); }}
      onCloseComplete={() => {
        if (!model.getSnapshot().deletePath) setClosingDeletePath(null);
      }}
      onDelete={() => model.confirmDelete()}
    />
    <NewDocumentDialog t={t}
      open={snapshot.dialogOpen}
      initialParent={snapshot.selectedFolder}
      kind={snapshot.createKind}
      busy={workbenchState.busy || snapshot.blocked || snapshot.creating}
      error={snapshot.createError}
      onClose={() => { model.closeCreateDialog(); }}
      onCreate={(parentPath, name) => model.create(parentPath, name)}
    />
  </>;
}

/** Mounted in a UI wrapper so the dialog stays available when the navigation content is hidden. */
export function ProjectDialogs({i18n, workbench, models}: ProjectManagementViewsProps) {
  const workbenchState = useWorkbench(workbench);
  const t = useTranslation(i18n);
  const session = workbenchState.session;
  const model = session ? models.get(session.id) : undefined;
  if (!session || !model) return null;
  return <ProjectDialogsForSession t={t} key={session.id} workbench={workbench} model={model} />;
}
