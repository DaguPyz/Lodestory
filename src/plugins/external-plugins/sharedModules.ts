import * as react from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";
import * as sdk from "@lodestory/sdk";
import * as layout from "@lodestory/sdk/layout";
import * as ui from "@lodestory/sdk/ui";
import * as navigation from "@lodestory/sdk/navigation-layout";
import * as theme from "@lodestory/sdk/theme";
import * as settings from "@lodestory/sdk/settings";
import * as error from "@lodestory/sdk/error";
import * as external from "@lodestory/sdk/external-plugins";
import * as packages from "@lodestory/sdk/plugin-packages";
import * as runtime from "@lodestory/sdk/plugin-runtime";
import * as nativeProcess from "@lodestory/sdk/native-process-loader";
import * as nativeLibrary from "@lodestory/sdk/native-library-loader";
import * as windowShell from "@lodestory/sdk/window-shell";
import * as workbench from "@lodestory/sdk/workbench";
import * as config from "@lodestory/sdk/config";
import * as storage from "@lodestory/sdk/project-storage";
import * as tasks from "@lodestory/sdk/background-tasks";
import * as documents from "@lodestory/sdk/documents";
import * as bodyEditor from "@lodestory/sdk/body-editor";
import * as canvas from "@lodestory/sdk/canvas";
import * as timeline from "@lodestory/sdk/timeline";
import * as assetCatalog from "@lodestory/sdk/asset-catalog";
import * as contextMenu from "@lodestory/sdk/context-menu";
import * as projectSearch from "@lodestory/sdk/project-search";
import * as shortcuts from "@lodestory/sdk/shortcuts";

const modules: Record<string, object> = {
  "react": react, "react/jsx-runtime": jsxRuntime, "react/jsx-dev-runtime": jsxDevRuntime,
  "react-dom": reactDom, "react-dom/client": reactDomClient,
  "@lodestory/sdk": sdk, "@lodestory/sdk/layout": layout, "@lodestory/sdk/ui": ui,
  "@lodestory/sdk/navigation-layout": navigation, "@lodestory/sdk/theme": theme,
  "@lodestory/sdk/settings": settings, "@lodestory/sdk/error": error,
  "@lodestory/sdk/external-plugins": external, "@lodestory/sdk/plugin-packages": packages,
  "@lodestory/sdk/plugin-runtime": runtime, "@lodestory/sdk/native-process-loader": nativeProcess,
  "@lodestory/sdk/native-library-loader": nativeLibrary, "@lodestory/sdk/window-shell": windowShell,
  "@lodestory/sdk/workbench": workbench, "@lodestory/sdk/config": config,
  "@lodestory/sdk/project-storage": storage, "@lodestory/sdk/background-tasks": tasks,
  "@lodestory/sdk/documents": documents, "@lodestory/sdk/body-editor": bodyEditor,
  "@lodestory/sdk/canvas": canvas, "@lodestory/sdk/timeline": timeline,
  "@lodestory/sdk/asset-catalog": assetCatalog, "@lodestory/sdk/context-menu": contextMenu,
  "@lodestory/sdk/project-search": projectSearch, "@lodestory/sdk/shortcuts": shortcuts,
};

let installed = false;
/** Import maps make the plugin's external dependencies point at the host's exact instances. */
export function installSharedModules() {
  if (installed) return;
  const globalName = "__lodestorySharedModules";
  Object.defineProperty(globalThis, globalName, {value: modules, configurable: true});
  const imports: Record<string, string> = {};
  const urls: string[] = [];
  try {
    for (const [specifier, namespace] of Object.entries(modules)) {
      const names = Object.keys(namespace).filter(name => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name));
      const source = `const m=globalThis[${JSON.stringify(globalName)}][${JSON.stringify(specifier)}];\n`
        + names.map(name => `export const ${name}=m[${JSON.stringify(name)}];`).join("\n")
        + ("default" in namespace ? "\nexport default m.default;" : "");
      const url = URL.createObjectURL(new Blob([source], {type: "text/javascript"}));
      urls.push(url);
      imports[specifier] = url;
    }
    const script = document.createElement("script");
    script.type = "importmap";
    script.textContent = JSON.stringify({imports});
    document.head.append(script);
    installed = true;
  } catch (error) {
    for (const url of urls) URL.revokeObjectURL(url);
    delete (globalThis as Record<string, unknown>)[globalName];
    throw error;
  }
}
