import type {Plugin} from "@lodestory/sdk";
import {canvasKey, type CanvasService, type CanvasSurfaceProps, type CanvasViewport} from "@lodestory/sdk/canvas";
import {i18nKey} from "@lodestory/sdk/i18n";
import {useTranslation} from "../../utils/useTranslation";
import {CanvasSurface} from "./CanvasSurface";
import {createCanvasViewport} from "./createCanvasViewport";

/** Supplies replaceable navigation surfaces, with no project or timeline knowledge. */
export function createCanvasPlugin(): Plugin {
  let stop: (() => void) | undefined;
  return {
    id: "canvas", requires: [i18nKey], provides: [canvasKey],
    activate(context) {
      const i18n = context.get(i18nKey);
      function LocalizedSurface(props: CanvasSurfaceProps) {
        return <CanvasSurface {...props} t={useTranslation(i18n)}/>;
      }
      let alive = true;
      const viewports = new Set<CanvasViewport>();
      const service: CanvasService = Object.freeze({
        Surface: LocalizedSurface,
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
