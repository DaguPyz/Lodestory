import {createRequire} from "node:module";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

const uiPackageRoot = fileURLToPath(new URL("../../packages/ui/", import.meta.url));
const requireFromUiPackage = createRequire(new URL("../../packages/ui/package.json", import.meta.url));

/**
 * Resolve only the public UI package and its direct Base UI runtime dependency
 * for isolated VM fixtures. Package files still pass through the fixture's own
 * loader/cache, while Base UI uses its published CommonJS condition.
 */
export function resolveUiPackageImport(specifier, load) {
  if (specifier === "@lodestory/ui") {
    return {handled: true, value: load(resolve(uiPackageRoot, "dist/index.js"))};
  }
  if (specifier === "@lodestory/ui/styles.css") {
    return {handled: true, value: {}};
  }
  if (specifier === "@base-ui/react/dialog" || specifier === "@base-ui/react/select" || specifier === "@base-ui/react/context-menu") {
    return {handled: true, value: requireFromUiPackage(specifier)};
  }
  return {handled: false};
}
