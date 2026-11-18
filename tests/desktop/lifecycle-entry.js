import {invoke} from "@tauri-apps/api/core";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {documentsKey} from "@lodestory/sdk/documents";
import {layoutKey} from "@lodestory/sdk/layout";
import {nativeProcessLoaderKey} from "@lodestory/sdk/native-process-loader";
import {nativeLibraryLoaderKey} from "@lodestory/sdk/native-library-loader";
import {pluginPackagesKey} from "@lodestory/sdk/plugin-packages";
import {externalPluginsKey} from "@lodestory/sdk/external-plugins";
import {settingsKey} from "@lodestory/sdk/settings";
import {uiKey} from "@lodestory/sdk/ui";
import {projectStorageKey} from "@lodestory/sdk/project-storage";
import {getCurrentWindow} from "@tauri-apps/api/window";
export function installLifecycleTest(runtime) {
  const workbench = runtime.get(workbenchKey);
  let restoreDestroy;
  let destroyCalls = 0;
  window.__lodestoryLifecycleTest = {
   importPluginPackage(path) {return runtime.get(pluginPackagesKey).importFromPath(path);},
   listPluginPackages() {return runtime.get(pluginPackagesKey).list();},
   enablePlugin(id) {return runtime.get(externalPluginsKey).enable(id);},
   disablePlugin(id) {return runtime.get(externalPluginsKey).disable(id);},
   uninstallPlugin(id) {return runtime.get(externalPluginsKey).uninstall(id);},
   startDevelopment(folder) {return runtime.get(externalPluginsKey).startDevelopment(folder);},
   retryDevelopment() {return runtime.get(externalPluginsKey).retryDevelopment();},
   stopDevelopment() {return runtime.get(externalPluginsKey).stopDevelopment();},
   developmentSnapshot() {return runtime.get(externalPluginsKey).getDevelopmentSnapshot();},
   pluginStatuses() {return runtime.get(externalPluginsKey).getSnapshot();},
   showLayoutContent(id) {return runtime.get(layoutKey).show(id);},
   layoutContents() {return runtime.get(layoutKey).getSnapshot().contents.map(item => item.id);},
   stopRuntime() {return runtime.stop();},
   openPage(id) {return runtime.get(uiKey).openPage(id);},
   backPage() {return runtime.get(uiKey).back();},
   fileState() {
     const session = workbench.getSnapshot().session;
     return session ? runtime.get(projectStorageKey).getFiles(session.id)?.getSnapshot().files.find(file => file.fileName === "正文.txt") : null;
   },
   delayAutosaveForTest() {
     const previous = window.setTimeout;
     window.setTimeout = function (callback, delay, ...args) {return previous(callback, delay === 700 ? 60000 : delay, ...args);};
     window.__restoreAutosaveTimer = () => {window.setTimeout = previous;};
   },
   restoreAutosaveTimer() {window.__restoreAutosaveTimer?.(); delete window.__restoreAutosaveTimer;},
   openPluginSettings() {return runtime.get(settingsKey).open("plugins.packages");},
   async openTemporaryProject(parentPath) {
     const {project} = await invoke("create_project", {parentPath, name: "生命周期测试"});
     return workbench.openProject(project);
   },
   openPreparedProject(project) { return workbench.openProject(project); },
   snapshot() { return workbench.getSnapshot(); },
   async openDocument(path) {
     const session = workbench.getSnapshot().session;
     const workspace = session && runtime.get(documentsKey).getWorkspace(session.id);
     if (!workspace) throw new Error("Test project workspace is not ready.");
     return workspace.open(path);
   },
   async createDocument() {
     const session = workbench.getSnapshot().session;
     const workspace = session && runtime.get(documentsKey).getWorkspace(session.id);
     if (!workspace) throw new Error("Test project workspace is not ready.");
     const result = await workspace.create("", "正文");
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
   async testScaffoldBackend(type, entry) {
     if (type !== "process" && type !== "dynamic-library") throw new Error("Unknown scaffold backend type.");
     const key = type === "process" ? nativeProcessLoaderKey : nativeLibraryLoaderKey;
     const backend = await runtime.get(key).load(entry);
     try {
       const success = await backend.call({requestId: "scaffold-1", operation: "ping", schemaVersion: "1.0.0", params: {text: "来自桌面测试"}});
       const error = await backend.call({requestId: "scaffold-2", operation: "unknown", schemaVersion: "1.0.0", params: null});
       await backend.close();
       let afterClose;
       try {await backend.call({requestId: "scaffold-3", operation: "ping", schemaVersion: "1.0.0", params: null});}
       catch (cause) {afterClose = String(cause);}
       return {success, error, afterClose};
     } finally {
       await backend.close();
     }
   },
   async startNativeProcessForClose(entry, markerPath) {
     const backend = await runtime.get(nativeProcessLoaderKey).load(entry);
     return backend.call({requestId: "configure", operation: "configureShutdown", schemaVersion: "1.0.0", params: {markerPath, rejectOnce: true}});
   },
   async testNativeLibrary(entry, markerPath) {
     const backend = await runtime.get(nativeLibraryLoaderKey).load(entry);
     try {
       const success = await backend.call({requestId: "lib-1", operation: "ping", schemaVersion: "1.0.0", params: {text: "来自 B 的请求"}});
       const error = await backend.call({requestId: "lib-2", operation: "unknown", schemaVersion: "1.0.0", params: null});
       await backend.call({requestId: "lib-3", operation: "configureShutdown", schemaVersion: "1.0.0", params: {markerPath, rejectOnce: false}});
       const delayed = backend.call({requestId: "lib-4", operation: "delay", schemaVersion: "1.0.0", params: {milliseconds: 100}});
       await backend.close();
       const completed = await delayed;
       let afterClose;
       try {await backend.call({requestId: "lib-5", operation: "ping", schemaVersion: "1.0.0", params: null});}
       catch (error) {afterClose = String(error);}
       return {success, error, completed, afterClose};
     } finally {await backend.close();}
   },
   async tryNativeLibraryLoad(entry) {
     try {const backend = await runtime.get(nativeLibraryLoaderKey).load(entry); await backend.close(); return null;}
     catch (error) {return String(error);}
   },
   async startNativeLibraryForClose(entry, markerPath) {
     const backend = await runtime.get(nativeLibraryLoaderKey).load(entry);
     return backend.call({requestId: "configure-lib", operation: "configureShutdown", schemaVersion: "1.0.0", params: {markerPath, rejectOnce: true}});
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
