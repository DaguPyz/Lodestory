import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

const source = await readFile(new URL("../src/plugins/project-storage/bufferProtocol.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;

function fallbackProtocol() {
  let yields = 0, closes = 0;
  const FallbackUint8Array = new Proxy(Uint8Array, {
    construct(target, args) {
      const result = Reflect.construct(target, args);
      Object.defineProperty(result, "toBase64", {value: undefined});
      return result;
    },
    get(target, name) { return name === "fromBase64" ? undefined : Reflect.get(target, name); },
  });
  const exports = {};
  vm.runInNewContext(compiled, {exports, Uint8Array: FallbackUint8Array, TextDecoder, Number, Error, atob,
    require(name) {
      assert.equal(name, "./bytes");
      return {createTaskScheduler() { return {async yieldTask() { yields++; }, close() { closes++; }}; }};
    },
  });
  return {...exports, stats: () => ({yields, closes})};
}

test("portable base64 preserves every byte, padding, BOM and CRLF without caller aliasing", async () => {
  const protocol = fallbackProtocol();
  for (const input of [new Uint8Array(), new Uint8Array([0]), new Uint8Array([0, 255]),
    new TextEncoder().encode("\uFEFF正文\r\n\0尾\n"), Uint8Array.from({length: 100_003}, (_, i) => i % 256)]) {
    const expected = Buffer.from(input).toString("base64");
    const pending = protocol.encodeByteData(input);
    if (input.length) input[0] ^= 255;
    const encoded = await pending;
    assert.equal(encoded, expected, "encoding captures mutable caller input before yielding");
    const decoded = await protocol.decodeByteData(encoded, Buffer.from(expected, "base64").length);
    assert.equal(Buffer.from(decoded).toString("base64"), expected);
  }
  assert.ok(protocol.stats().yields > 0, "large portable conversions yield instead of building a giant JS number array");
  assert.ok(protocol.stats().closes > 0);
  await assert.rejects(protocol.decodeByteData("A===", 1));
  await assert.rejects(protocol.decodeByteData("AA==", 2), /长度/);
});

test("native compact save uses a lossless binary frame while other compact and legacy paths stay unchanged", async () => {
  const calls = [];
  const bytes = [0, 255, 13, 10, 0xef, 0xbb, 0xbf];
  const f = createMainFixture({invokeHandler(command, args) {
    calls.push({command, args});
    if (command === "read_project_file_base64") return {path: args.path, fileName: "text.txt",
      bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.length};
    if (command === "read_project_file") return {path: args.path, fileName: "text.md", bytes};
    return undefined;
  }});
  const api = f.loadModule("plugins/project-storage/storageApi.ts");
  assert.deepEqual(Array.from((await api.readFile("/book", "text.txt", {preferByteView: true})).bytes), bytes);
  await api.saveFile("/book", "text.txt", new Uint8Array([1, 0, 255]), new Uint8Array(bytes));
  await api.deleteFile("/book", "text.txt", new Uint8Array(bytes));
  assert.equal(calls[1].command, "save_project_file_binary");
  assert.ok(calls[1].args instanceof Uint8Array, "compact save is sent as a raw Uint8Array payload");
  const frame = calls[1].args;
  const metadataLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  const metadataEnd = 4 + metadataLength;
  const metadata = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(frame.subarray(4, metadataEnd)));
  assert.deepEqual(metadata, {version: 1, projectPath: "/book", path: "text.txt", byteLength: 3, expectedByteLength: bytes.length});
  assert.deepEqual(Array.from(frame.subarray(metadataEnd, metadataEnd + metadata.byteLength)), [1, 0, 255]);
  assert.deepEqual(Array.from(frame.subarray(metadataEnd + metadata.byteLength)), bytes);
  assert.equal(calls[2].command, "delete_project_file_base64");
  await api.readFile("/book", "text.md");
  await api.saveFile("/book", "text.md", [1], [0]);
  assert.equal(calls[3].command, "read_project_file");
  assert.equal(calls[4].command, "save_project_file");

  const bad = createMainFixture({invokeHandler() { return {path: "bad.txt", fileName: "bad.txt", bytesBase64: "AA==", byteLength: 2}; }});
  await assert.rejects(bad.loadModule("plugins/project-storage/storageApi.ts").readFile("/book", "bad.txt", {preferByteView: true}), /长度/);
});
