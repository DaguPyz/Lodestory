import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { createSdkLoader } from "./sdkFixture.mjs";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

export function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

/** Load app/core source plus public SDK contracts; accidental business imports still fail immediately. */
export function fixture() {
  const modules = new Map();
  const sdk = createSdkLoader({ modules });
  const createdCores = [];

  function resolveModule(fromPath, specifier) {
    if (!specifier.startsWith(".")) {
      throw new Error(`Unexpected non-local import '${specifier}' from ${fromPath}`);
    }
    const base = resolve(dirname(fromPath), specifier);
    const candidates = [base, `${base}.ts`, resolve(base, "index.ts")];
    const path = candidates.find((candidate) => {
      const relativePath = relative(sourceRoot, candidate);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) return false;
      if (!relativePath.startsWith("app/") && !relativePath.startsWith("plugin-core/")) return false;
      try {
        readFileSync(candidate, "utf8");
        return true;
      } catch {
        return false;
      }
    });
    if (!path) throw new Error(`Import '${specifier}' from ${fromPath} is outside app/plugin-core.`);
    return path;
  }

  function load(path) {
    const cached = modules.get(path);
    if (cached) return cached;
    const relativePath = relative(sourceRoot, path);
    if (!relativePath.startsWith("app/") && !relativePath.startsWith("plugin-core/")) {
      throw new Error(`Module '${relativePath}' is outside app/plugin-core.`);
    }
    const source = readFileSync(path, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    modules.set(path, exports);
    vm.runInNewContext(compiled, {
      exports,
      require(specifier) {
        if (specifier.startsWith("@lodestory/sdk")) return sdk.requireSdk(specifier, relativePath);
        return load(resolveModule(path, specifier));
      },
    }, { filename: path });
    return exports;
  }

  const engineCoreModule = load(resolve(sourceRoot, "plugin-core/EngineCore.ts"));
  const BaseEngineCore = engineCoreModule.EngineCore;
  class TrackedEngineCore extends BaseEngineCore {
    constructor(...args) {
      super(...args);
      createdCores.push(this);
    }
  }
  engineCoreModule.EngineCore = TrackedEngineCore;
  const pluginCore = load(resolve(sourceRoot, "plugin-core/index.ts"));

  return {
    ...pluginCore,
    createdCores,
    loadModule(relativePath) {
      const path = resolve(sourceRoot, relativePath);
      return load(path);
    },
    requireSdk(specifier) { return sdk.requireSdk(specifier); },
  };
}

export function serviceKey(id) {
  return Object.freeze({ id, token: Symbol(id) });
}

export function plugin({ id, requires = [], provides = [], activate, deactivate }) {
  return { id, requires, provides, activate, deactivate };
}

export function loadAppRuntime(f = fixture()) {
  return { ...f, ...f.loadModule("app/createAppRuntime.ts") };
}

export function assertTypeFixtureCompiles() {
  const fixturePath = fileURLToPath(new URL("../fixtures/app-runtime-types.ts", import.meta.url));
  const program = ts.createProgram([fixturePath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(diagnostic => ({
    file: diagnostic.file?.fileName,
    line: diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
      : undefined,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  })), []);
}
