import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error Node types are not included in this minimal template.
import { createRequire } from "node:module";
// @ts-expect-error Node types are not included in this minimal template.
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;
const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [
    react(),
    ...(process.env.LODESTORY_DESKTOP_E2E === "1" ? [{
      name: "desktop-e2e-driver",
      transformIndexHtml: {
        order: "pre" as const,
        handler() {
          return [{tag: "script", attrs: {type: "module", src: "/tests/desktop/driver.js"}, injectTo: "head-prepend" as const}];
        }
      }
    }] : [])
  ],
  // The browser export uses document.createElement, which is unavailable in workers.
  // The package's default export provides the same decoding without a DOM.
  resolve: { alias: { "decode-named-character-reference": require.resolve("decode-named-character-reference") } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] }
  }
});
