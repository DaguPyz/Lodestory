import {invoke} from "@tauri-apps/api/core";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {documentsKey} from "@lodestory/sdk/documents";
import {layoutKey} from "@lodestory/sdk/layout";
import {nativeProcessLoaderKey} from "@lodestory/sdk/native-process-loader";
import {getCurrentWindow} from "@tauri-apps/api/window";
export function installLifecycleTest(runtime) {
  const workbench = runtime.get(workbenchKey);
  let restoreDestroy;
  let destroyCalls = 0;
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
   focusWindow() {return getCurrentWindow().setFocus();},
   async testNativeProcess(entry) {
     const backend = await runtime.get(nativeProcessLoaderKey).load(entry);
     try {
       const success = await backend.call({requestId: "test-1", operation: "ping", schemaVersion: "1.0.0", params: {text: "来自 A 的请求"}});
       const error = await backend.call({requestId: "test-2", operation: "unknown", schemaVersion: "1.0.0", params: null});
       return {success, error};
     } finally {
       await backend.close();
     }
   },
   async startNativeProcessForClose(entry, markerPath) {
     const backend = await runtime.get(nativeProcessLoaderKey).load(entry);
     return backend.call({requestId: "configure", operation: "configureShutdown", schemaVersion: "1.0.0", params: {markerPath, rejectOnce: true}});
   },
   requestWindowClose() {return getCurrentWindow().close();},
   holdWindowDestroy() {
     const prototype = Object.getPrototypeOf(getCurrentWindow());
     const original = prototype.destroy;
     prototype.destroy = async function () {destroyCalls++;};
     restoreDestroy = () => {prototype.destroy = original;};
   },
   destroyCalls() {return destroyCalls;},
   restoreWindowDestroy() {restoreDestroy?.(); restoreDestroy = undefined;},
  };
}
