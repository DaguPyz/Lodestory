import {createMainFixture} from "./mainStartupFixture.mjs";

/** Test-only byte filesystem used by integration tests; production has no in-memory fallback. */
export function byteStorageFixture({onInvoke} = {}) {
  const disk = new Map();
  const directories = new Set();
  const issues = new Map();
  const calls = [];
  const transports = [];
  const key = (project, path = "") => path ? `${project}/${path}` : project;
  const parent = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const f = createMainFixture({async invokeHandler(command, args) {
    transports.push({command, args});
    if (command === "save_project_file_binary") {
      args = decodeBinarySaveFrame(args);
      command = "save_project_file";
    }
    const compact = command.endsWith("_base64");
    if (compact) {
      command = command.slice(0, -"_base64".length);
      args = {...args,
        ...(typeof args.bytesBase64 === "string" ? {bytes: [...Buffer.from(args.bytesBase64, "base64")]} : {}),
        ...(typeof args.expectedBytesBase64 === "string" ? {expectedBytes: [...Buffer.from(args.expectedBytesBase64, "base64")]} : {}),
      };
      delete args.bytesBase64;
      delete args.expectedBytesBase64;
    }
    calls.push({command, args});
    if (onInvoke) await onInvoke(command, args);
    if (command === "list_documents") return [];
    const root = args.projectPath;
    directories.add(root);
    const fileKey = key(root, args.path);
    function ensureParents(path) {
      const parts = path.split("/").filter(Boolean);
      for (let index = 1; index <= parts.length; index++) {
        const directory = key(root, parts.slice(0, index).join("/"));
        if (disk.has(directory)) throw new Error("目录位置已有文件");
        directories.add(directory);
      }
    }
    if (command === "read_project_file") {
      if (!disk.has(fileKey)) throw new Error("文件不存在");
      const bytes = [...disk.get(fileKey)];
      return compact ? {path: args.path, fileName: args.path.split("/").at(-1), bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.length}
        : {path: args.path, fileName: args.path.split("/").at(-1), bytes};
    }
    if (command === "create_project_file") {
      if (disk.has(fileKey)) {
        if (!args.acceptIdentical || !equal(disk.get(fileKey), args.bytes)) throw new Error("文件已存在，未覆盖");
      } else {
        if (args.createParents) ensureParents(parent(args.path));
        if (!directories.has(key(root, parent(args.path)))) throw new Error("父目录不存在");
        disk.set(fileKey, [...args.bytes]);
      }
      const bytes = [...disk.get(fileKey)];
      return compact ? {path: args.path, fileName: args.path.split("/").at(-1), bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.length}
        : {path: args.path, fileName: args.path.split("/").at(-1), bytes};
    }
    if (command === "save_project_file" || command === "delete_project_file") {
      if (!disk.has(fileKey) || !equal(disk.get(fileKey), args.expectedBytes)) throw new Error("外部修改，未改动文件");
      if (command === "delete_project_file") disk.delete(fileKey);
      else disk.set(fileKey, [...args.bytes]);
      return;
    }
    if (command === "create_project_directory") {
      if (args.recursive) ensureParents(args.path);
      else {
        if (directories.has(fileKey) || disk.has(fileKey)) throw new Error("同名目录或文件存在");
        if (!directories.has(key(root, parent(args.path)))) throw new Error("父目录不存在");
        directories.add(fileKey);
      }
      return;
    }
    if (command === "rename_project_path") {
      const from = key(root, args.fromPath);
      const to = key(root, args.toPath);
      if (!disk.has(from) && !directories.has(from)) throw new Error("源文件或目录不存在");
      if (disk.has(to) || directories.has(to)) throw new Error("目标已存在，未覆盖");
      if (!directories.has(key(root, parent(args.toPath)))) throw new Error("目标父目录不存在");
      const remap = path => path === from ? to : `${to}${path.slice(from.length)}`;
      for (const [path, bytes] of [...disk]) {
        if (path === from || path.startsWith(`${from}/`)) { disk.delete(path); disk.set(remap(path), bytes); }
      }
      for (const path of [...directories]) {
        if (path === from || path.startsWith(`${from}/`)) { directories.delete(path); directories.add(remap(path)); }
      }
      return;
    }
    if (command === "list_project_directory") {
      if (disk.has(fileKey)) throw new Error("目标不是目录");
      const exists = directories.has(fileKey);
      const entries = [];
      if (exists) {
        const prefix = `${fileKey}/`;
        for (const [path, bytes] of disk) {
          if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/")) continue;
          const name = path.slice(prefix.length);
          entries.push({path: args.path ? `${args.path}/${name}` : name, name, kind: "file", size: bytes.length});
        }
        for (const path of directories) {
          if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/")) continue;
          const name = path.slice(prefix.length);
          entries.push({path: args.path ? `${args.path}/${name}` : name, name, kind: "directory", size: null});
        }
      }
      return {exists, entries, issues: issues.get(fileKey) ?? []};
    }
    throw new Error(`Unexpected command ${command}`);
  }});
  return {f, disk, directories, issues, calls, transports, key,
    files(project = "/book", options) { return f.loadModule("plugins/project-storage/createProjectFiles.ts").createProjectFiles(project, options); },
  };
}
function equal(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }

/** Independently decodes the raw save frame so fixture hooks keep seeing legacy semantics. */
function decodeBinarySaveFrame(frame) {
  if (!(frame instanceof Uint8Array) || frame.byteLength < 4) throw new Error("Malformed binary project save frame.");
  const metadataLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  const metadataEnd = 4 + metadataLength;
  if (metadataEnd > frame.byteLength) throw new Error("Malformed binary project save metadata length.");
  let metadata;
  try { metadata = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(frame.subarray(4, metadataEnd))); }
  catch { throw new Error("Malformed binary project save metadata."); }
  if (!metadata || metadata.version !== 1 || typeof metadata.projectPath !== "string" || typeof metadata.path !== "string"
    || !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0
    || !Number.isSafeInteger(metadata.expectedByteLength) || metadata.expectedByteLength < 0) {
    throw new Error("Malformed binary project save metadata fields.");
  }
  const dataEnd = metadataEnd + metadata.byteLength;
  const expectedEnd = dataEnd + metadata.expectedByteLength;
  if (!Number.isSafeInteger(expectedEnd) || expectedEnd !== frame.byteLength) {
    throw new Error("Malformed binary project save payload length.");
  }
  return {
    projectPath: metadata.projectPath,
    path: metadata.path,
    bytes: Array.from(frame.subarray(metadataEnd, dataEnd)),
    expectedBytes: Array.from(frame.subarray(dataEnd, expectedEnd)),
  };
}
