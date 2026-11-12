import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/project-management/projectFilesApi.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture({ desktop = true, result = [], failure } = {}) {
  const calls = [];
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "@tauri-apps/api/core") return {
        isTauri: () => desktop,
        invoke: async (...args) => {
          calls.push(args);
          if (failure) throw failure;
          return result;
        },
      };
      throw new Error(`Unexpected import: ${name}`);
    },
    Error,
  });
  return { ...exports, calls };
}

test("the project files API lists entries through the desktop command for its project", async () => {
  const entries = [{ path: "chapters", name: "chapters", children: [{ path: "chapters/one.txt", name: "one.txt" }] }];
  const api = fixture({ result: entries });

  assert.deepEqual(await api.listDocuments("/stories/book"), entries);
  assert.deepEqual(Array.from(api.calls, ([command, args]) => [command, { ...args }]), [
    ["list_documents", { projectPath: "/stories/book" }],
  ]);
});

test("the project files API reports desktop and backend errors without hiding their messages", async () => {
  const browserApi = fixture({ desktop: false });
  await assert.rejects(browserApi.listDocuments("/stories/book"), /请在桌面应用中操作作品文档/);
  assert.deepEqual(browserApi.calls, []);

  const backendFailure = fixture({ failure: new Error("目录读取失败") });
  await assert.rejects(backendFailure.listDocuments("/stories/book"), /目录读取失败/);
  assert.equal(backendFailure.projectFilesErrorMessage({ message: "权限不足" }), "权限不足");
  assert.equal(backendFailure.projectFilesErrorMessage("暂不可用"), "暂不可用");
  assert.equal(backendFailure.projectFilesErrorMessage(undefined), "文档操作失败，请重试。");
});
