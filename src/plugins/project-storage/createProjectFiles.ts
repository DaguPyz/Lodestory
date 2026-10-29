import type {ProjectByteView, ProjectDirectoryListing, ProjectFileAccessOptions, ProjectFileCreateOptions, ProjectFileData, ProjectFileSnapshot, ProjectFile, ProjectFiles, ProjectPathRename} from "@lodestory/sdk/project-storage";
import {FileSession} from "./FileSession";
import {createDirectory, createFile, deleteFile, listDirectory, readFile, renamePath as renameProjectPath, saveFile, storageErrorMessage, type FileRecord} from "./storageApi";
import {copyBytes, copyBytesAsync} from "./bytes";
import {createProjectByteView, projectFileDataEquals} from "./byteView";

type Options = {canMutate?: () => boolean; canLoad?: () => boolean};

/** Storage owns the buffers; consumers own their open lists and presentation. */
export function createProjectFiles(projectPath: string, options: Options = {}) {
  const buffers = new Map<string, FileSession>();
  const listeners = new Set<() => void>();
  const pathChangeListeners = new Set<(change: ProjectPathRename) => void>();
  const pending = new Set<Promise<unknown>>();
  const opening = new Map<string, Promise<ProjectFile | null>>();
  const changing = new Set<string>();
  const canMutate = options.canMutate ?? (() => true);
  const canLoad = options.canLoad ?? canMutate;
  let checkingLeave = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let error: string | null = null;
  let snapshot: ProjectFileSnapshot = Object.freeze({files: Object.freeze([]), blocked: !canMutate(), error});

  function blocked() { return disposed || checkingLeave || !canMutate(); }
  function pathChanging(path: string) {
    if (typeof path !== "string") return false;
    if (path === "") return changing.size > 0;
    return [...changing].some(changed => path === changed || path.startsWith(`${changed}/`) || changed.startsWith(`${path}/`));
  }
  function notify() {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(); } catch (cause) { console.error("Project file subscriber failed.", {error: cause}); }
    }
  }
  function publish() {
    if (disposed) return;
    const next = [...buffers.values()].map(buffer => buffer.file);
    const previous = snapshot.files;
    const files = next.length === previous.length && next.every((file, index) => file === previous[index])
      ? previous : Object.freeze(next);
    if (files === snapshot.files && snapshot.blocked === blocked() && snapshot.error === error) return;
    snapshot = Object.freeze({files, blocked: blocked(), error});
    notify();
  }
  function run<T>(action: () => Promise<T>, accepted?: () => void): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (cause: unknown) => void;
    const operation = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    try { accepted?.(); void Promise.resolve().then(action).then(resolve, reject); }
    catch (cause) { reject(cause); }
    return operation;
  }
  async function drain() {
    const failures: unknown[] = [];
    while (pending.size) {
      for (const result of await Promise.allSettled([...pending])) if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length) throw Object.assign(new Error("Project file operations could not finish."), {errors: failures});
  }
  function validPath(path: unknown, root = false): path is string {
    return typeof path === "string" && (root && path === "" || path.length > 0 && !/[\\:\u0000-\u001f\u007f-\u009f]/.test(path)
      && path.split("/").every(part => part.length > 0 && part !== "." && part !== ".."));
  }
  function fail(cause: unknown) { error = storageErrorMessage(cause); publish(); }
  function install(record: FileRecord, preferByteView = false) {
    const buffer = new FileSession(record,
      (path, bytes, expectedBytes) => saveFile(projectPath, path, bytes, expectedBytes), publish, preferByteView);
    buffers.set(record.path, buffer);
    return buffer;
  }
  async function validateRecord(record: FileRecord, path: string, preferByteView = false): Promise<FileRecord> {
    if (!record || record.path !== path || record.fileName !== path.split("/").pop()) {
      throw new Error("项目文件返回了无效内容。");
    }
    const captured = {path: record.path, fileName: record.fileName, bytes: record.bytes};
    if (preferByteView) return {...captured, bytes: createProjectByteView(captured.bytes)};
    if (!Array.isArray(captured.bytes)) throw new Error("项目文件返回了无效内容。");
    return {...captured, bytes: await copyBytesAsync(captured.bytes)};
  }
  async function saveAllInternal() {
    const current = [...buffers.values()];
    const results = await Promise.all(current.map(buffer => buffer.save()));
    const failed = current.find((_buffer, index) => !results[index]);
    error = failed?.file.saveError ?? (failed ? "项目内容保存失败。" : null);
    publish();
    return !failed;
  }

  const service: ProjectFiles = Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      const subscription = () => listener();
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
    subscribePathChanges(listener: (change: ProjectPathRename) => void) {
      if (disposed) return () => {};
      pathChangeListeners.add(listener);
      return () => { pathChangeListeners.delete(listener); };
    },
    captureBytes(data: ProjectFileData): ProjectByteView {
      if (disposed) throw new Error("项目文件服务已关闭，无法捕获字节。");
      return createProjectByteView(data);
    },
    read(path: string, accessOptions: ProjectFileAccessOptions = {}) {
      if (disposed || checkingLeave || !canLoad() || pathChanging(path)) return Promise.resolve(null);
      if (!accessOptions || typeof accessOptions !== "object"
        || accessOptions.preferByteView !== undefined && typeof accessOptions.preferByteView !== "boolean") {
        fail("文件访问选项无效。"); return Promise.resolve(null);
      }
      const preferByteView = accessOptions.preferByteView === true;
      if (!validPath(path)) { fail("文件路径必须是项目内的有效相对路径。"); return Promise.resolve(null); }
      const existing = buffers.get(path);
      if (existing?.isDirty || existing?.file.saveState === "saving") {
        if (preferByteView) existing.useByteView();
        return Promise.resolve(existing.file);
      }
      const previous = opening.get(path);
      if (previous) {
        if (!preferByteView) return previous;
        return previous.then(file => {
          if (!file) return null;
          const latest = buffers.get(path);
          latest?.useByteView();
          return latest?.file ?? file;
        });
      }
      const operation = run(async () => {
        try {
          const record = await validateRecord(await readFile(projectPath, path, {preferByteView}), path, preferByteView);
          if (disposed) return null;
          const latest = buffers.get(path);
          if (latest?.isDirty || latest?.file.saveState === "saving") {
            if (preferByteView) latest.useByteView();
            return latest.file;
          }
          if (latest && projectFileDataEquals(latest.persistedData, record.bytes)) {
            if (preferByteView) latest.useByteView();
            return latest.file;
          }
          latest?.finishDelete();
          const file = install(record, preferByteView).file;
          error = null;
          publish();
          return file;
        } catch (cause) { fail(cause); return null; }
      }, () => { error = null; publish(); });
      opening.set(path, operation);
      void operation.finally(() => { if (opening.get(path) === operation) opening.delete(path); });
      return operation;
    },
    readTransient(path: string) {
      if (disposed || checkingLeave || !canLoad() || !validPath(path) || pathChanging(path)) return Promise.resolve(null);
      const buffered = buffers.get(path);
      if (buffered?.isDirty || buffered?.file.saveState === "saving") {
        return Promise.resolve(createProjectByteView(buffered.file.byteView ?? buffered.file.bytes));
      }
      return run(async () => {
        try {
          const record = await validateRecord(await readFile(projectPath, path, {preferByteView: true}), path, true);
          if (disposed || pathChanging(path)) return null;
          const latest = buffers.get(path);
          if (latest?.isDirty || latest?.file.saveState === "saving") {
            return createProjectByteView(latest.file.byteView ?? latest.file.bytes);
          }
          return createProjectByteView(record.bytes);
        } catch { return null; }
      });
    },
    create(path: string, data: ProjectFileData, options: ProjectFileCreateOptions = {}) {
      if (blocked()) return Promise.resolve(null);
      if (!options || typeof options !== "object"
        || options.preferByteView !== undefined && typeof options.preferByteView !== "boolean"
        || options.createParents !== undefined && typeof options.createParents !== "boolean"
        || options.acceptIdentical !== undefined && typeof options.acceptIdentical !== "boolean") {
        fail("文件路径或创建选项无效。"); return Promise.resolve(null);
      }
      const preferByteView = options.preferByteView === true;
      let bytes: ProjectFileData;
      try { bytes = preferByteView ? createProjectByteView(data) : copyBytes(data); } catch (cause) { fail(cause); return Promise.resolve(null); }
      if (!validPath(path)) {
        fail("文件路径或创建选项无效。"); return Promise.resolve(null);
      }
      const createOptions = {preferByteView, createParents: options.createParents ?? false, acceptIdentical: options.acceptIdentical ?? false};
      const existing = buffers.get(path);
      if (pathChanging(path) || opening.has(path) || existing?.isDirty || existing?.file.saveState === "saving") {
        fail("同一路径文件正在编辑或操作。"); return Promise.resolve(null);
      }
      return run(async () => {
        try {
          const record = await validateRecord(await createFile(projectPath, path, bytes, createOptions), path, preferByteView);
          existing?.finishDelete();
          const file = install(record, preferByteView).file;
          error = null;
          publish();
          return file;
        } catch (cause) { fail(cause); return null; }
        finally { changing.delete(path); publish(); }
      }, () => { changing.add(path); error = null; publish(); });
    },
    list(path: string) {
      if (disposed || checkingLeave || !canLoad() || pathChanging(path)) return Promise.resolve(null);
      if (!validPath(path, true)) { fail("目录路径必须位于项目内。"); return Promise.resolve(null); }
      return run(async () => {
        try {
          const listing = await listDirectory(projectPath, path);
          if (disposed) return null;
          if (!listing || typeof listing.exists !== "boolean" || !Array.isArray(listing.entries) || !Array.isArray(listing.issues)) {
            throw new Error("目录返回了无效信息。");
          }
          const result: ProjectDirectoryListing = Object.freeze({
            exists: listing.exists,
            entries: Object.freeze(listing.entries.map(entry => Object.freeze({...entry}))),
            issues: Object.freeze(listing.issues.map(issue => Object.freeze({...issue}))),
          });
          error = null;
          publish();
          return result;
        } catch (cause) { fail(cause); return null; }
      });
    },
    createDirectory(path: string, options: {recursive?: boolean} = {}) {
      if (blocked()) return Promise.resolve(false);
      if (!validPath(path) || pathChanging(path) || options.recursive !== undefined && typeof options.recursive !== "boolean") {
        fail("目录路径或创建选项无效。"); return Promise.resolve(false);
      }
      const recursive = options.recursive ?? false;
      return run(async () => {
        try { await createDirectory(projectPath, path, recursive); error = null; publish(); return true; }
        catch (cause) { fail(cause); return false; }
      });
    },
    renamePath(fromPath: string, toPath: string) {
      if (blocked()) return Promise.resolve(false);
      if (!validPath(fromPath) || !validPath(toPath)) {
        fail("重命名路径必须是项目内的有效相对路径。"); return Promise.resolve(false);
      }
      if (fromPath === toPath) return Promise.resolve(true);
      if (toPath.startsWith(`${fromPath}/`)) {
        fail("不能将目录重命名到自身内部。"); return Promise.resolve(false);
      }
      if (pathChanging(fromPath) || pathChanging(toPath)) {
        fail("相关项目路径正在操作，请稍后重试。"); return Promise.resolve(false);
      }

      const locks = [fromPath, toPath];
      const accepted = [...pending];
      return run(async () => {
        try {
          const previousResults = await Promise.allSettled(accepted);
          const rejected = previousResults.find(result => result.status === "rejected");
          if (rejected?.status === "rejected") throw rejected.reason;
          if (disposed || !canMutate()) throw new Error("项目正在切换，无法重命名文件。");

          const affected = [...buffers].filter(([path]) => path === fromPath || path.startsWith(`${fromPath}/`));
          const targetPaths = affected.map(([path]) => `${toPath}${path.slice(fromPath.length)}`);
          if (targetPaths.some(path => buffers.has(path) && !affected.some(([source]) => source === path))) {
            throw new Error("目标位置已有打开的文件，未执行重命名。");
          }

          const saves = await Promise.all(affected.map(([, buffer]) => buffer.save()));
          const failedIndex = saves.findIndex(saved => !saved);
          if (failedIndex >= 0) {
            throw new Error(affected[failedIndex][1].file.saveError ?? "重命名前保存失败，文件内容已保留。");
          }
          if (affected.some(([, buffer]) => buffer.isDirty || buffer.file.saveState !== "saved")) {
            throw new Error("相关文件尚未保存完成，未执行重命名。");
          }

          await renameProjectPath(projectPath, fromPath, toPath);
          const pathChange = Object.freeze({fromPath, toPath});
          for (const listener of [...pathChangeListeners]) {
            if (!pathChangeListeners.has(listener)) continue;
            try { listener(pathChange); }
            catch (cause) { console.error("Project path change listener failed.", {error: cause, pathChange}); }
          }
          const moved = affected.map(([path, buffer]) => [path, `${toPath}${path.slice(fromPath.length)}`, buffer] as const);
          for (const [path] of affected) buffers.delete(path);
          for (const [, path, buffer] of moved) {
            buffer.relocate(path);
            buffers.set(path, buffer);
          }
          error = null;
          publish();
          return true;
        } catch (cause) { fail(cause); return false; }
        finally {
          for (const path of locks) changing.delete(path);
          publish();
        }
      }, () => {
        for (const path of locks) changing.add(path);
        error = null;
        publish();
      });
    },
    write(path: string, bytes: ProjectFileData, accessOptions: ProjectFileAccessOptions = {}) {
      if (blocked() || pathChanging(path)) return false;
      if (!accessOptions || typeof accessOptions !== "object"
        || accessOptions.preferByteView !== undefined && typeof accessOptions.preferByteView !== "boolean") {
        fail("文件访问选项无效。"); return false;
      }
      const buffer = buffers.get(path);
      if (!buffer) return false;
      try { buffer.write(bytes, accessOptions); return true; }
      catch (cause) { fail(cause); return false; }
    },
    save(path: string) {
      if (disposed || pathChanging(path)) return Promise.resolve(false);
      const buffer = buffers.get(path);
      if (!buffer) return Promise.resolve(false);
      return run(async () => {
        const saved = await buffer.save();
        if (!saved) fail(buffer.file.saveError ?? "项目文件保存失败。");
        return saved;
      });
    },
    saveAll() { return disposed ? Promise.resolve(false) : run(saveAllInternal); },
    delete(path: string, options: {discardChanges?: boolean} = {}) {
      if (blocked() || pathChanging(path) || opening.has(path)) return Promise.resolve(false);
      if (!validPath(path) || options.discardChanges !== undefined && typeof options.discardChanges !== "boolean") {
        fail("文件路径或删除选项无效。"); return Promise.resolve(false);
      }
      const buffer = buffers.get(path);
      if (buffer?.isDirty && options.discardChanges !== true) {
        fail("文件有未保存修改；确认后才能删除。"); return Promise.resolve(false);
      }
      let acceptedSave: Promise<boolean> = Promise.resolve(true);
      let deleted = false;
      return run(async () => {
        try {
          if (!await acceptedSave) throw new Error(buffer?.file.saveError ?? "删除前保存失败，内容已保留。");
          const expectedBytes = buffer ? buffer.persistedData : (await readFile(projectPath, path)).bytes;
          await deleteFile(projectPath, path, expectedBytes);
          deleted = true;
          buffer?.finishDelete();
          if (buffers.get(path) === buffer) buffers.delete(path);
          error = null;
          return true;
        } catch (cause) { fail(cause); return false; }
        finally {
          if (buffer && !deleted) buffer.cancelDelete(!disposed);
          changing.delete(path);
          publish();
        }
      }, () => {
        changing.add(path);
        acceptedSave = buffer?.beginDelete() ?? Promise.resolve(true);
        error = null;
        publish();
      });
    },
    clearError() { if (!disposed && error !== null) { error = null; publish(); } },
  });

  function beginLeave() {
    if (disposed || checkingLeave) return Promise.resolve(false);
    checkingLeave = true;
    publish();
    return (async () => {
      try { await drain(); return await saveAllInternal(); }
      catch (cause) { fail(cause); return false; }
    })();
  }
  function endLeave() { if (!disposed && checkingLeave) { checkingLeave = false; publish(); } }
  function dispose(): Promise<void> {
    if (disposal) return disposal;
    let complete!: () => void;
    let reject!: (cause: unknown) => void;
    disposal = new Promise<void>((done, fail) => { complete = done; reject = fail; });
    disposed = true;
    snapshot = Object.freeze({...snapshot, blocked: true});
    notify();
    listeners.clear();
    pathChangeListeners.clear();
    void (async () => {
      let operationFailure: unknown;
      try { await drain(); } catch (cause) { operationFailure = cause; }
      const current = [...buffers.values()];
      const results = await Promise.allSettled(current.map(buffer => buffer.dispose()));
      if (operationFailure !== undefined || results.some(result => result.status === "rejected" || !result.value)) {
        snapshot = Object.freeze({files: Object.freeze(current.map(buffer => buffer.file)), blocked: true, error: "停止时有项目文件未能保存，内容已保留。"});
        const cause = new Error("Project files could not be saved while stopping.");
        Object.defineProperty(cause, "snapshot", {value: snapshot});
        if (operationFailure !== undefined) Object.defineProperty(cause, "operationFailure", {value: operationFailure});
        throw cause;
      }
      buffers.clear();
      snapshot = Object.freeze({files: Object.freeze([]), blocked: true, error: null});
    })().then(complete, reject);
    return disposal;
  }
  return {service, beginLeave, endLeave, dispose, refreshBlocked: publish};
}
