import {useSyncExternalStore} from "react";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import type {ProjectManagementModel} from "./projectManagementModel";
import {NewDocumentDialog} from "./NewDocumentDialog";
import {DeleteDocumentDialog} from "./DeleteDocumentDialog";
import {ProjectTree} from "./ProjectTree";
import "./project-management.css";

type ProjectManagementViewsProps = {
  workbench: WorkbenchService;
  models: ReadonlyMap<string, ProjectManagementModel>;
};

function useWorkbench(workbench: WorkbenchService) {
  return useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
}

function ProjectFilesForSession({workbench, model, active}: {
  workbench: WorkbenchService;
  model: ProjectManagementModel;
  active: boolean;
}) {
  const workbenchState = useWorkbench(workbench);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const canInteract = active && workbenchState.active && !workbenchState.busy && !snapshot.blocked;
  return <ProjectTree
    projectName={snapshot.projectName}
    entries={snapshot.entries}
    activeDocumentPath={snapshot.activeDocumentPath}
    openingPath={snapshot.openingPath}
    loading={snapshot.loading}
    error={snapshot.error}
    active={canInteract}
    newDisabled={!canInteract || snapshot.creating || snapshot.loading || snapshot.dialogOpen || !!snapshot.deletePath || snapshot.deleting || !!snapshot.deletingPath}
    deletingPath={snapshot.deletingPath}
    onOpenDocument={path => model.openDocument(path)}
    onSelectFolder={path => { model.selectFolder(path); }}
    onNewDocument={(parentPath, extension) => { model.requestCreate(parentPath, extension); }}
    onNewDirectory={parentPath => { model.requestCreateDirectory(parentPath); }}
    onDeleteDocument={path => { model.requestDelete(path); }}
    onReload={() => { void model.refresh(); }}
  />;
}

/** Registered as the project's navigation content; layout owns its placement. */
export function ProjectFiles({workbench, models, active}: ProjectManagementViewsProps & {active: boolean}) {
  const workbenchState = useWorkbench(workbench);
  const session = workbenchState.session;
  const model = session ? models.get(session.id) : undefined;
  if (!session || !model) return null;
  return <ProjectFilesForSession key={session.id} workbench={workbench} model={model} active={active} />;
}

function ProjectDialogsForSession({workbench, model}: {workbench: WorkbenchService; model: ProjectManagementModel}) {
  const workbenchState = useWorkbench(workbench);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  if (!workbenchState.active) return null;
  if (snapshot.deletePath) return <DeleteDocumentDialog
    key={snapshot.deletePath}
    path={snapshot.deletePath}
    busy={workbenchState.busy || snapshot.blocked || snapshot.deleting || !!snapshot.deletingPath}
    error={snapshot.deleteError}
    onClose={() => { model.closeDeleteDialog(); }}
    onDelete={() => model.confirmDelete()}
  />;
  if (!snapshot.dialogOpen) return null;
  return <NewDocumentDialog
    key={`${snapshot.sessionId}:${snapshot.createKind}:${snapshot.createExtension ?? "default"}`}
    projectName={snapshot.projectName}
    entries={snapshot.entries}
    initialParent={snapshot.selectedFolder}
    kind={snapshot.createKind}
    extension={snapshot.createExtension}
    busy={workbenchState.busy || snapshot.blocked || snapshot.creating}
    error={snapshot.createError}
    onClose={() => { model.closeCreateDialog(); }}
    onCreate={(parentPath, name) => model.create(parentPath, name)}
  />;
}

/** Mounted in a UI wrapper so the dialog stays available when the navigation content is hidden. */
export function ProjectDialogs({workbench, models}: ProjectManagementViewsProps) {
  const workbenchState = useWorkbench(workbench);
  const session = workbenchState.session;
  const model = session ? models.get(session.id) : undefined;
  if (!session || !model) return null;
  return <ProjectDialogsForSession key={session.id} workbench={workbench} model={model} />;
}
