import {createMainFixture} from "./mainStartupFixture.mjs";

/** Test-only byte filesystem used by integration tests; production has no in-memory fallback. */
export function byteStorageFixture({onInvoke} = {}) {
  const disk = new Map();
  const directories = new Set();
  const issues = new Map();
  const calls = [];
  const key = (project, path = "") => path ? `${project}/${path}` : project;
  const parent = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const f = createMainFixture({async invokeHandler(command, args) {
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
      return {path: args.path, fileName: args.path.split("/").at(-1), bytes: [...disk.get(fileKey)]};
    }
    if (command === "create_project_file") {
      if (disk.has(fileKey)) {
        if (!args.acceptIdentical || !equal(disk.get(fileKey), args.bytes)) throw new Error("文件已存在，未覆盖");
      } else {
        if (args.createParents) ensureParents(parent(args.path));
        if (!directories.has(key(root, parent(args.path)))) throw new Error("父目录不存在");
        disk.set(fileKey, [...args.bytes]);
      }
      return {path: args.path, fileName: args.path.split("/").at(-1), bytes: [...disk.get(fileKey)]};
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
  return {f, disk, directories, issues, calls, key,
    files(project = "/book", options) { return f.loadModule("plugins/project-storage/createProjectFiles.ts").createProjectFiles(project, options); },
  };
}
function equal(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
