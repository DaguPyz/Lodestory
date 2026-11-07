import {invoke} from "@tauri-apps/api/core";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {documentsKey} from "@lodestory/sdk/documents";
import {layoutKey} from "@lodestory/sdk/layout";
export function installLifecycleTest(runtime) {
  const workbench = runtime.get(workbenchKey);
  window.__lodestoryLifecycleTest = {
   async openTemporaryProject(parentPath) {
     const {project} = await invoke("create_project", {parentPath, name: "生命周期测试"});
     return workbench.openProject(project);
   },
   snapshot() { return workbench.getSnapshot(); },
   async createDocument() {
     const session = workbench.getSnapshot().session;
     const workspace = session && runtime.get(documentsKey).getWorkspace(session.id);
     if (!workspace) throw new Error("Test project workspace is not ready.");
     const result = await workspace.create("", "正文.txt");
     if (!result) throw new Error("Could not create test document.");
     return result.id;
   },
   hasWritingStatus() {return runtime.get(layoutKey).getSnapshot().contents.some(item => item.id === "writing-status.status");},
   async tryUnloadEditor() {
     try { await runtime.unmount("plain-text-editor"); return null; }
     catch (error) { return {phase: error.phase, message: error.cause?.message}; }
   },
   unloadWritingStatus() {return runtime.unmount("writing-status");},
   async unloadTimeline() {
     await runtime.unmount("outline-design");
     await runtime.unmount("timeline");
   },
   closeProject() {return workbench.closeProject();},
  };
}
