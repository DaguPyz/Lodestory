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
  "      create-plugin --type <process|dynamic-library> --name <项目名> [--output <目录>]",
  "",
  "不带选项时按提示选择类型和填写项目名。",
  "process：生成独立程序后端；dynamic-library：生成动态库后端。",
  "项目名须以小写英文字母开头，只包含小写字母、数字、连字符或下划线。",
  "默认在当前目录下创建与项目同名的目录；目标目录不能已存在。",
].join("\n");

const nameError = "项目名无效：请使用不超过 64 个小写英文字母、数字、连字符或下划线，且以字母开头；不能使用 Rust 或 Cargo 的保留名称。";

function validName(name) {
  return typeof name === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(name)
    && !reservedNames.has(name.replaceAll("-", "_"));
}

/** Ask for the two required options without writing files until both are valid. */
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
    let type;
    while (!type) {
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
    return {type, name};
  } finally {
    reader.close();
  }
}

export function parseArgs(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return {help: true};
  const allowed = new Map([["--type", "type"], ["--name", "name"], ["--output", "output"]]);
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
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
  if (!types.has(options.type)) throw new Error("--type 必须是 process 或 dynamic-library。");
  if (!validName(options.name)) throw new Error(nameError);
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

/** Create a new standalone backend directory; existing paths are never overwritten. */
export async function createProject(options, fs = filesystem) {
  validate(options);
  const destination = path.resolve(options.output ?? options.name);
  const templateFiles = [
    ["shared/gitignore.template", ".gitignore"],
    ["shared/protocol.rs", "src/protocol.rs"],
    [options.type + "/Cargo.toml.template", "Cargo.toml"],
    [options.type + "/README.md.template", "README.md"],
    [options.type + (options.type === "process" ? "/main.rs" : "/lib.rs"),
      options.type === "process" ? "src/main.rs" : "src/lib.rs"],
  ];
  const values = {
    "__PROJECT_NAME__": options.name,
    "__LIBRARY_NAME__": options.name.replaceAll("-", "_"),
  };
  const rendered = await Promise.all(templateFiles.map(async ([source, target]) => {
    let content = await fs.readFile(path.join(templateRoot, source), "utf8");
    for (const [placeholder, value] of Object.entries(values)) content = content.replaceAll(placeholder, value);
    return {target, content};
  }));

  try {
    await fs.mkdir(destination);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("目标目录或文件已存在，未覆盖：" + destination);
    throw new Error("无法创建目标目录：" + destination + "（" + error.message + "）", {cause: error});
  }

  const createdDirectories = [destination];
  const createdFiles = [];
  try {
    const sourceDirectory = path.join(destination, "src");
    await fs.mkdir(sourceDirectory);
    createdDirectories.push(sourceDirectory);
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
