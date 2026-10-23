import type {Plugin} from "@lodestory/sdk";
import {canvasKey, type CanvasService, type CanvasViewport} from "@lodestory/sdk/canvas";
import {CanvasSurface} from "./CanvasSurface";
import {createCanvasViewport} from "./createCanvasViewport";

/** Supplies replaceable navigation surfaces, with no project or timeline knowledge. */
export function createCanvasPlugin(): Plugin {
  let stop: (() => void) | undefined;
  return {
    id: "canvas", requires: [], provides: [canvasKey],
    activate(context) {
      let alive = true;
      const viewports = new Set<CanvasViewport>();
      const service: CanvasService = Object.freeze({
        Surface: CanvasSurface,
        createViewport(initial) {
          if (!alive) throw new Error("Canvas service is no longer active.");
          const viewport = createCanvasViewport(initial, () => viewports.delete(viewport));
          viewports.add(viewport);
          return viewport;
        },
      });
      stop = () => {
        alive = false;
        for (const viewport of [...viewports]) viewport.dispose();
        viewports.clear();
      };
      context.provide(canvasKey, service);
    },
    deactivate() { const cleanup = stop; stop = undefined; cleanup?.(); },
  };
}
