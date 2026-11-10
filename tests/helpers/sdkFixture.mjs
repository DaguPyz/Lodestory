import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sdkSourceRoot = resolve(repositoryRoot, "packages/sdk/src");
const publicEntries = {
  "@lodestory/sdk/body-editor": ["body-editor.ts"],
  "@lodestory/sdk/canvas": ["canvas.ts"],
  "@lodestory/sdk/timeline": ["timeline.ts"],
  "@lodestory/sdk/asset-catalog": ["asset-catalog.ts"],
  "@lodestory/sdk/config": ["config.ts"],
  "@lodestory/sdk/context-menu": ["context-menu.ts"],
  "@lodestory/sdk/documents": ["documents.ts"],
  "@lodestory/sdk/project-storage": ["project-storage.ts"],
  "@lodestory/sdk/background-tasks": ["background-tasks.ts"],
  "@lodestory/sdk/native-process-loader": ["native-process-loader.ts"],
  "@lodestory/sdk/native-library-loader": ["native-library-loader.ts"],
  "@lodestory/sdk/project-search": ["project-search.ts"],
  "@lodestory/sdk/shortcuts": ["shortcuts.ts"],
  "@lodestory/sdk": ["index.ts"],
  "@lodestory/sdk/workbench": ["workbench.ts"],
  "@lodestory/sdk/layout": ["layout.ts"],
  "@lodestory/sdk/navigation-layout": ["navigation-layout.ts"],
  "@lodestory/sdk/settings": ["settings.ts"],
  "@lodestory/sdk/window-shell": ["window-shell.ts"],
  "@lodestory/sdk/ui": ["ui.ts", "ui/index.ts"],
  "@lodestory/sdk/error": ["error.ts"],
  "@lodestory/sdk/theme": ["theme.ts", "theme/index.ts"],
};

/**
 * Add SDK package entry points to a fixture's existing synthetic CommonJS graph.
 * Sharing `modules` is important: all SDK subpath imports then observe the same
 * ServiceKey module, so each exported capability key is created only once.
 */
export function createSdkLoader({ modules = new Map(), globals = {} } = {}) {
  const evaluatedModules = [];
  const imports = [];

  function findSource(candidates, description) {
    const path = candidates.find((candidate) => {
      try {
        readFileSync(candidate, "utf8");
        return true;
      } catch {
        return false;
      }
    });
    if (!path) throw new Error(`Cannot resolve SDK module '${description}' from ${sdkSourceRoot}`);
    return path;
  }

  function resolveSdkRelative(fromPath, specifier) {
    if (!specifier.startsWith(".")) {
      throw new Error(`Unexpected external SDK import '${specifier}' from ${relative(sdkSourceRoot, fromPath)}`);
    }
    const base = resolve(dirname(fromPath), specifier);
    const withoutJs = base.endsWith(".js") ? base.slice(0, -3) : base;
    return findSource([
      base,
      `${withoutJs}.ts`,
      `${withoutJs}.tsx`,
      resolve(withoutJs, "index.ts"),
      resolve(withoutJs, "index.tsx"),
    ], specifier);
  }

  function loadSource(path) {
    const cached = modules.get(path);
    if (cached) return cached;
    const relativePath = relative(sdkSourceRoot, path);
    if (relativePath.startsWith("..")) throw new Error(`SDK module '${path}' is outside ${sdkSourceRoot}`);

    const source = readFileSync(path, "utf8");
    const compiled = ts.transpileModule(source, {
      fileName: path,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText;
    const exports = {};
    modules.set(path, exports);
    evaluatedModules.push(relativePath);
    vm.runInNewContext(compiled, {
      exports,
      require(specifier) {
        imports.push({ from: relativePath, specifier });
        return loadSource(resolveSdkRelative(path, specifier));
      },
      ...globals,
    }, { filename: path });
    return exports;
  }

  function requireSdk(specifier, importer = "fixture") {
    imports.push({ from: importer, specifier });
    const entryCandidates = publicEntries[specifier];
    if (!entryCandidates) throw new Error(`Unknown SDK package entry '${specifier}' imported by ${importer}`);
    const path = findSource(entryCandidates.map((entry) => resolve(sdkSourceRoot, entry)), specifier);
    return loadSource(path);
  }

  return {
    requireSdk,
    loadSdkSource(relativePath) { return loadSource(resolve(sdkSourceRoot, relativePath)); },
    modules,
    imports,
    evaluatedModules,
  };
}
