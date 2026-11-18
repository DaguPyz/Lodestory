import {useLayoutEffect, useRef, useState, useSyncExternalStore} from "react";
import type {CanvasService, CanvasViewport, CanvasViewportSnapshot} from "@lodestory/sdk/canvas";

type RelationViewport = {
  assetId: string;
  canvas: CanvasService;
  viewport: CanvasViewport;
  initial: CanvasViewportSnapshot;
};

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

/** Each centered asset has its own view. Zoom follows navigation within a relation view. */
export function useTimelineRelationViewport(canvas: CanvasService, assetId?: string) {
  const [relation, setRelation] = useState<RelationViewport | null>(null);
  const zoom = useRef(1);
  useLayoutEffect(() => {
    if (!assetId) {
      zoom.current = 1;
      setRelation(null);
      return;
    }
    const viewport = canvas.createViewport({zoom: zoom.current});
    setRelation({assetId, canvas, viewport, initial: viewport.getSnapshot()});
    return () => {
      zoom.current = viewport.getSnapshot().zoom;
      viewport.dispose();
    };
  }, [canvas, assetId]);

  const current = relation && relation.assetId === assetId && relation.canvas === canvas ? relation : null;
  const viewport = current?.viewport ?? null;
  const view = useSyncExternalStore(viewport?.subscribe ?? emptySubscribe, viewport?.getSnapshot ?? emptySnapshot, emptySnapshot);
  return {viewport, view, moved: Boolean(current && view !== current.initial)};
}
