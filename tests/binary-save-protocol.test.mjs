import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(await readFile(new URL("../src/plugins/project-storage/binarySaveProtocol.ts", import.meta.url), "utf8"), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const exports = {};
vm.runInNewContext(source, {exports, Uint8Array, DataView, TextEncoder, Number, Array, JSON, Error,
  require(name) {
    assert.equal(name, "./bufferProtocol");
    return {isByteView: data => data && typeof data.copyTo === "function"};
  },
});
const {encodeBinarySave} = exports;

// Decode independently of the product encoder so the on-wire boundaries are checked.
function decode(body) {
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true);
  const start = 4 + length;
  const meta = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(body.subarray(4, start)));
  assert.equal(body.length, start + meta.byteLength + meta.expectedByteLength);
  return {meta, data: [...body.subarray(start, start + meta.byteLength)], expected: [...body.subarray(start + meta.byteLength)]};
}

test("binary save frames preserve opaque bytes and Unicode paths including empty payloads", () => {
  for (const [data, expected] of [
    [new Uint8Array(), new Uint8Array()],
    [Uint8Array.from({length: 256}, (_, index) => index), new Uint8Array([0xff, 0xfe, 0, 13, 10])],
    [new TextEncoder().encode("\uFEFF正文\r\n\0尾\n"), new Uint8Array()],
    [new Uint8Array(), new TextEncoder().encode("旧内容\r\n")],
  ]) {
    const projectPath = "/项目/有空格 a/\"引用\"", path = "正文/原稿.txt";
    const result = decode(encodeBinarySave(projectPath, path, data, expected));
    assert.deepEqual(result.meta, {version: 1, projectPath, path, byteLength: data.length, expectedByteLength: expected.length});
    assert.deepEqual(result.data, [...data]);
    assert.deepEqual(result.expected, [...expected]);
  }
});

test("outgoing frames capture caller memory and copy immutable views without a legacy projection", () => {
  const data = new Uint8Array([8, 1, 0, 255, 9]).subarray(1, 4);
  const expected = [13, 10, 0];
  const body = encodeBinarySave("/book", "draft.txt", data, expected);
  data.fill(7); expected.fill(8);
  assert.deepEqual(decode(body).data, [1, 0, 255]);
  assert.deepEqual(decode(body).expected, [13, 10, 0]);

  const raw = new Uint8Array([0, 255, 13, 10]);
  let copies = 0;
  const view = Object.freeze({byteLength: raw.length,
    get bytes() { throw new Error("legacy projection requested"); },
    copyTo(target, offset = 0, from = 0, length = raw.length - from) {
      copies++; target.set(raw.subarray(from, from + length), offset);
    },
  });
  const fromView = encodeBinarySave("/book", "binary.dat", view, view);
  assert.equal(copies, 2);
  assert.deepEqual(decode(fromView).data, [...raw]);
  assert.deepEqual(decode(fromView).expected, [...raw]);
});

test("invalid lengths or byte values never produce an outgoing frame", () => {
  for (const byteLength of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => encodeBinarySave("/book", "file", {byteLength, copyTo() {}}, []), /长度/);
  }
  for (const data of [[256], [-1], [1.5]]) {
    assert.throws(() => encodeBinarySave("/book", "file", data, []), /字节/);
  }
  assert.throws(() => encodeBinarySave(null, "file", [], []), /路径/);
});
