import * as filesystem from "node:fs/promises";
import path from "node:path";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";

const templateRoot = fileURLToPath(new URL("../templates/", import.meta.url));
const types = new Set(["process", "dynamic-library"]);
const reservedNames = new Set([
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
  "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
  "move", "mut", "pub", "ref", "return", "self", "static", "struct", "super", "test",
  "trait", "true", "type", "unsafe", "use", "where", "while", "abstract", "become",
  "box", "do", "final", "macro", "override", "priv", "try", "typeof", "unsized",
  "virtual", "yield",
]);

export const usage = [
  "用法：create-plugin",
  "      create-plugin --name <项目名> [--id <插件 ID>] [--frontend] [--type <process|dynamic-library>] [--output <目录>]",
  "",
  "不带选项时按提示选择前端和后端，并填写项目名称及插件 ID。",
  "--frontend 添加前端；--type 选择独立程序或动态库后端，至少选择其中一项。",
  "项目名须以小写英文字母开头，只包含小写字母、数字、连字符或下划线。",
  "默认在当前目录下创建与项目同名的目录；目标目录不能已存在。",
].join("\n");

const nameError = "项目名无效：请使用不超过 64 个小写英文字母、数字、连字符或下划线，且以字母开头；不能使用 Rust 或 Cargo 的保留名称。";

function validName(name) {
  return typeof name === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(name)
    && !reservedNames.has(name.replaceAll("-", "_"));
}

function validId(id) {
  return typeof id === "string" && id.length <= 200
    && /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)+$/.test(id);
}

/** Ask for project options without writing files until the inputs are valid. */
export async function promptOptions(input, output) {
  const reader = createInterface({input, crlfDelay: Infinity});
  const lines = reader[Symbol.asyncIterator]();
  async function ask(question) {
    output.write(question);
    const {value, done} = await lines.next();
    if (done) throw new Error("输入已结束，未创建项目。");
    return value.trim();
  }
  try {
    let composition;
    while (!composition) {
      const choice = await ask("选择项目组成（1：仅前端；2：仅后端；3：前端和后端）：");
      if (["1", "2", "3"].includes(choice)) composition = choice;
      else output.write("请输入 1、2 或 3。\n");
    }
    let type;
    while (composition !== "1" && !type) {
      const choice = await ask("选择后端类型（1：独立程序 C；2：动态库 D）：");
      if (choice === "1") type = "process";
      else if (choice === "2") type = "dynamic-library";
      else output.write("请输入 1 或 2。\n");
    }
    let name;
    while (!validName(name)) {
      name = await ask("项目名称：");
      if (!validName(name)) output.write(nameError + "\n");
    }
    let id;
    const example = "com.example." + name;
    while (!id) {
      const answer = await ask("插件 ID（例如 com.example.my-plugin，留空使用 " + example + "）：");
      if (!answer || validId(answer)) id = answer || example;
      else output.write("插件 ID 需要至少两段，用英文、数字、下划线或连字符表示，以点分隔。\n");
    }
    return {type, name, id, frontend: composition !== "2"};
  } finally {
    reader.close();
  }
}

export function parseArgs(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return {help: true};
  const allowed = new Map([["--type", "type"], ["--name", "name"], ["--id", "id"], ["--output", "output"]]);
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--frontend") {
      if (result.frontend) throw new Error("选项不能重复：" + option);
      result.frontend = true;
      continue;
    }
    const key = allowed.get(option);
    if (!key) throw new Error("未知选项：" + option);
    if (Object.hasOwn(result, key)) throw new Error("选项不能重复：" + option);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("选项缺少值：" + option);
    result[key] = value;
  }
  return result;
}

function validate(options) {
  if (options.type !== undefined && !types.has(options.type)) throw new Error("--type 必须是 process 或 dynamic-library。");
  if (options.frontend !== undefined && typeof options.frontend !== "boolean") throw new Error("前端选项无效。");
  if (!options.frontend && !options.type) throw new Error("请通过 --frontend 或 --type 选择前端和后端。");
  if (!validName(options.name)) throw new Error(nameError);
  if (options.id !== undefined && !validId(options.id)) {
    throw new Error("插件 ID 需要至少两段，用英文、数字、下划线或连字符表示，以点分隔。");
  }
  if (options.output !== undefined && (typeof options.output !== "string" || !options.output.trim())) {
    throw new Error("输出目录不能为空。");
  }
}

async function cleanCreated(fs, files, directories) {
  const errors = [];
  for (const file of files.reverse()) {
    try { await fs.unlink(file); }
    catch (error) { if (error.code !== "ENOENT") errors.push(file); }
  }
  for (const directory of directories.reverse()) {
    try { await fs.rmdir(directory); }
    catch (error) { if (error.code !== "ENOENT") errors.push(directory); }
  }
  return errors;
}

/** Create a new plugin project directory; existing paths are never overwritten. */
export async function createProject(options, fs = filesystem) {
  validate(options);
  const destination = path.resolve(options.output ?? options.name);
  const templateFiles = [
    ["project/gitignore.template", ".gitignore"],
    ["project/README.md.template", "README.md"],
    ["project/build.mjs", "scripts/build.mjs"],
  ];
  if (options.frontend) templateFiles.push(
    ["frontend/index.tsx", "frontend/src/index.tsx"],
    ["frontend/Panel.tsx", "frontend/src/Panel.tsx"],
    ["frontend/globals.d.ts", "frontend/src/globals.d.ts"],
    ["frontend/tsconfig.json", "frontend/tsconfig.json"],
  );
  if (options.type) templateFiles.push(
    ["shared/protocol.rs", "backend/src/protocol.rs"],
    [options.type + "/Cargo.toml.template", "backend/Cargo.toml"],
    [options.type + (options.type === "process" ? "/main.rs" : "/lib.rs"),
      options.type === "process" ? "backend/src/main.rs" : "backend/src/lib.rs"],
  );
  const values = {
    "__PROJECT_NAME__": options.name,
    "__LIBRARY_NAME__": options.name.replaceAll("-", "_"),
  };
  const rendered = await Promise.all(templateFiles.map(async ([source, target]) => {
    let content = await fs.readFile(path.join(templateRoot, source), "utf8");
    for (const [placeholder, value] of Object.entries(values)) content = content.replaceAll(placeholder, value);
    return {target, content};
  }));
  const configuration = {
    id: options.id ?? "com.example." + options.name,
    name: options.name,
    version: "0.1.0",
    description: "",
    compatibility: {hostApi: "^1.0.0", ...(options.frontend ? {react: "^19.1.0"} : {})},
    dependencies: {
      plugins: [],
      requires: options.frontend ? [{id: "lodestory/layout@1", version: "^1.0.0"}] : [],
      provides: [],
    },
    ...(options.frontend ? {frontend: {entry: "frontend/src/index.tsx"}} : {}),
    ...(options.type ? {backend: {type: options.type}} : {}),
  };
  const packageJson = {
    name: options.name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {build: "node scripts/build.mjs build", package: "node scripts/build.mjs package"},
    devDependencies: {
      jszip: "^3.10.1",
      semver: "^7.8.5",
      ...(options.frontend ? {
        "@lodestory/sdk": "^0.1.0",
        "@types/react": "^19.1.8",
        esbuild: "^0.28.1",
        react: "^19.1.0",
        typescript: "~6.0.3",
      } : {}),
    },
  };
  rendered.push({target: "plugin.json", content: JSON.stringify(configuration, null, 2) + "\n"});
  rendered.push({target: "package.json", content: JSON.stringify(packageJson, null, 2) + "\n"});

  try {
    await fs.mkdir(destination);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("目标目录或文件已存在，未覆盖：" + destination);
    throw new Error("无法创建目标目录：" + destination + "（" + error.message + "）", {cause: error});
  }

  const createdDirectories = [destination];
  const createdFiles = [];
  try {
    const directories = new Set();
    for (const {target} of rendered) {
      let directory = path.dirname(target);
      while (directory !== ".") {
        directories.add(directory);
        directory = path.dirname(directory);
      }
    }
    for (const directory of [...directories].sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length)) {
      const absolute = path.join(destination, directory);
      await fs.mkdir(absolute);
      createdDirectories.push(absolute);
    }
    for (const {target, content} of rendered) {
      const file = path.join(destination, target);
      const handle = await fs.open(file, "wx");
      createdFiles.push(file);
      try { await handle.writeFile(content, "utf8"); }
      finally { await handle.close(); }
    }
  } catch (error) {
    const residual = await cleanCreated(fs, createdFiles, createdDirectories);
    const detail = residual.length ? "；未能清理的路径：" + residual.join("、") : "；已清理本次创建的文件。";
    throw new Error("创建项目失败：" + error.message + detail, {cause: error});
  }
  return destination;
}
