import type {Translate} from "@lodestory/sdk/i18n";
import {useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode} from "react";
import type {AssetCatalog, AssetCatalogSnapshot} from "@lodestory/sdk/asset-catalog";
import type {AssetRelationNetwork, AssetRelationSnapshot} from "@lodestory/sdk/asset-relations";
import type {CanvasService} from "@lodestory/sdk/canvas";
import {Button, Icon} from "@lodestory/ui";
import type {TimelineEvent} from "./timelineEventStore";
import {getTimelineAssetOrbit, isRelationInViewport, layoutRelationLabels, relationLabelPosition, timelineFocusEventCenter, type OrbitSlot} from "./timelineAssetOrbit";
import {groupFocusAssets, relationLabelsByAsset} from "./timelineFocusAssetData";
import {useTimelineRelationViewport} from "./useTimelineRelationViewport";
import {allRelationCategories, TimelineRelationCategoryFilter, type RelationCategoryFilter} from "./TimelineRelationCategoryFilter";
import {TimelineTextZoomSwitch} from "./TimelineTextZoomSwitch";
import "./timeline-focus-assets.css";

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;
const fontSizeInPixels = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

export type AssetClickPosition = Readonly<{x: number; y: number; width: number}>;
export type FocusedAsset = Readonly<{id: string; previous: FocusedAsset | null}>;
export type TimelineFocusTarget = "timeline" | "event" | FocusedAsset;

const sceneInset = {top: 56, bottom: 72, horizontal: 24};
const entrancePhaseCount = 3;
const sceneVariables = {
  "--timeline-focus-inset-top": `${sceneInset.top}px`,
  "--timeline-focus-inset-bottom": `${sceneInset.bottom}px`,
  "--timeline-focus-inset-inline": `${sceneInset.horizontal}px`,
  "--timeline-focus-event-x": `${timelineFocusEventCenter.x}%`,
  "--timeline-focus-event-y": `${timelineFocusEventCenter.y}%`,
} as CSSProperties;

function moveToCenter(element: HTMLElement, origin: AssetClickPosition) {
  const styles = getComputedStyle(element);
  const duration = Number.parseFloat(styles.getPropertyValue("--timeline-focus-center-duration"));
  if (!(duration > 0)) return;

  const {left, top, width, height} = element.getBoundingClientRect();
  const x = origin.x - left - width / 2;
  const y = origin.y - top - height / 2;
  const animation = element.animate([
    {transform: `translate(${x}px, ${y}px) scale(${origin.width / width})`},
    {transform: `translate(${x * 0.62}px, ${y * 0.62}px) scale(0.705)`, offset: 0.35},
    {transform: "none"},
  ], {duration, easing: styles.getPropertyValue("--ui-ease-enter").trim()});
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cancelWhenReduced = () => {
    if (preference.matches || document.documentElement.dataset.uiMotion === "reduce") animation.cancel();
  };
  preference.addEventListener("change", cancelWhenReduced);
  const observer = new MutationObserver(cancelWhenReduced);
  observer.observe(document.documentElement, {attributes: true, attributeFilter: ["data-ui-motion"]});
  const detach = () => {
    preference.removeEventListener("change", cancelWhenReduced);
    observer.disconnect();
  };
  void animation.finished.then(detach, detach);
  return () => { animation.cancel(); detach(); };
}

function playAssetPress(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0 || event.ctrlKey) return;
  const node = event.currentTarget;
  const face = node.firstElementChild;
  if (!(face instanceof HTMLElement)) return;
  const style = getComputedStyle(face);
  if (Number.parseFloat(style.getPropertyValue("--ui-duration-fast")) === 0) return;

  face.style.setProperty("--timeline-focus-press-start", style.scale);
  node.dataset.clicked = "";
  face.dataset.pressing = "";
  // Restart the same CSS animation on rapid clicks, using the size already on screen.
  const press = face.getAnimations().find(animation => animation instanceof CSSAnimation
    && animation.animationName === "timeline-focus-asset-press");
  const clearPress = () => { delete face.dataset.pressing; };
  if (!press) {
    clearPress();
    return;
  }
  press.onfinish = clearPress;
  press.oncancel = clearPress;
  press.currentTime = 0;
  press.play();
}

function assetPressOrigin(button: HTMLButtonElement) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.uiMotion === "reduce") return null;
  const face = button.querySelector(".timeline-focus-asset-face") ?? button;
  const {left, top, width, height} = face.getBoundingClientRect();
  return {x: left + width / 2, y: top + height / 2, width};
}

type PositionedAsset = Readonly<{id: string; name: string; position: OrbitSlot; labelPosition: {x: number; y: number}; label: string}>;
type FocusNodeStyle = CSSProperties & Partial<Record<`--timeline-focus-${string}`, string | number>>;

function relationSegment(position: OrbitSlot, center: number, zoom: number, nodeRem: number) {
  const offsetX = position.offsetX * zoom;
  const offsetY = position.offsetY * zoom;
  const ratio = Math.max(0, 1 - Math.max(12, 2.2 * nodeRem) / Math.hypot(offsetX, offsetY));
  return `M${center} ${center}L${center - offsetX * ratio} ${center - offsetY * ratio}`;
}

export function TimelineFocusAssets({t, canvas, event, catalog, network, focusedAsset, origin, size, closing, onFocusAsset, onNavigate, onBack, onExited, children}: {
  t: Translate;
  canvas: CanvasService;
  event: TimelineEvent;
  catalog: AssetCatalog | null;
  network: AssetRelationNetwork | null;
  focusedAsset: FocusedAsset | null;
  origin?: AssetClickPosition | null;
  size: Readonly<{width: number; height: number}>;
  closing: boolean;
  onFocusAsset(id: string, origin: AssetClickPosition | null): void;
  onNavigate(target: TimelineFocusTarget): void;
  onBack(): void;
  onExited(): void;
  children: ReactNode;
}) {
  const assetId = focusedAsset?.id;
  const snapshot = useSyncExternalStore<AssetCatalogSnapshot | null>(
    catalog?.subscribe ?? emptySubscribe, catalog?.getSnapshot ?? emptySnapshot, emptySnapshot,
  );
  const activeNetwork = assetId ? network : null;
  const relationSnapshot = useSyncExternalStore<AssetRelationSnapshot | null>(
    activeNetwork?.subscribe ?? emptySubscribe, activeNetwork?.getSnapshot ?? emptySnapshot, emptySnapshot,
  );
  const relationLabels = useMemo(() => assetId && activeNetwork && relationSnapshot?.loaded
    ? relationLabelsByAsset(assetId, activeNetwork.getRelations(assetId)) : null, [assetId, activeNetwork, relationSnapshot]);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [focusedPeerId, setFocusedPeerId] = useState<string>();
  const [scaleTextWithZoom, setScaleTextWithZoom] = useState(false);
  const [controlsTarget, setControlsTarget] = useState<HTMLDivElement | null>(null);
  const [categorySelection, setCategorySelection] = useState<{asset: FocusedAsset; filter: RelationCategoryFilter} | null>(null);
  const activeCategorySelection = categorySelection?.asset === focusedAsset ? categorySelection : null;
  const categoryFilter = activeCategorySelection?.filter ?? allRelationCategories;
  const changeCategoryFilter = useCallback((filter: RelationCategoryFilter) => {
    if (focusedAsset) setCategorySelection({asset: focusedAsset, filter});
  }, [focusedAsset]);
  const assetIds = useMemo(() => assetId ? [...(relationLabels?.keys() ?? [])] : event.assetIds, [assetId, relationLabels, event.assetIds]);
  const catalogReady = Boolean(snapshot?.loaded && !snapshot.blocked && !snapshot.error);
  const breadcrumbs = useMemo(() => {
    const path: {label: string; target: TimelineFocusTarget}[] = [];
    if (focusedAsset) {
      const names = new Map(snapshot?.assets.map(asset => [asset.id, asset.name]));
      for (let asset: FocusedAsset | null = focusedAsset; asset; asset = asset.previous) {
        path.push({label: names.get(asset.id) ?? (catalogReady ? t("资产不可用") : t("资产待确认")), target: asset});
      }
    }
    path.push({label: event.title, target: "event"}, {label: t("时间线"), target: "timeline"});
    return path.reverse();
  }, [focusedAsset, event.title, snapshot?.assets, catalogReady]);
  const categoryGroups = useMemo(() => groupFocusAssets(assetIds, snapshot, t), [assetIds, snapshot, t]);
  const groups = useMemo(() => categoryFilter.mode === "all" ? categoryGroups : categoryGroups.filter(({id}) =>
    categoryFilter.categoryIds.has(id) === (categoryFilter.mode === "include")), [categoryGroups, categoryFilter]);
  const highlightedPeerId = useMemo(() => selectedPeerId && groups.some(group => group.items.some(({id}) => id === selectedPeerId))
    ? selectedPeerId : null, [groups, selectedPeerId]);
  const centerGroup = useMemo(() => assetId ? groupFocusAssets([assetId], snapshot, t)[0] : undefined, [assetId, snapshot, t]);
  const center = centerGroup?.items[0];
  const scene = useRef<HTMLDivElement>(null);
  const viewportElement = useRef<HTMLDivElement>(null);
  const relationLabelId = useId();
  const centerMotion = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLHeadingElement>(null);
  const breadcrumbBar = useRef<HTMLElement>(null);
  const timelineCrumb = useRef<HTMLButtonElement>(null);
  const previousAsset = useRef(focusedAsset);
  const total = useMemo(() => groups.reduce((count, group) => count + group.items.length, 0), [groups]);
  const viewWidth = size.width - 2 * sceneInset.horizontal;
  const viewHeight = size.height - sceneInset.top - sceneInset.bottom;
  const diameter = Math.min(viewWidth, viewHeight, 600);
  const rem = assetId ? fontSizeInPixels() : 16;
  const compact = diameter < 440 * rem / 16;
  const orbit = useMemo(() => compact ? null : getTimelineAssetOrbit(groups.map(group => ({count: group.items.length})),
    {width: diameter, height: diameter}, assetId ? {spacing: 12 * rem, offsetRings: true} : undefined),
  [groups, diameter, compact, assetId, rem]);
  const pannable = Boolean(assetId && !compact);
  const {viewport: relationViewport, view: relationView, moved: relationMoved} = useTimelineRelationViewport(canvas, assetId);
  const graphZoom = pannable ? relationView?.zoom ?? 1 : 1;
  const diagramSize = (orbit?.diameter ?? diameter) * graphZoom;
  const overflow = !compact && (diagramSize > viewWidth || diagramSize > viewHeight);
  const scrollableEvent = !assetId && overflow;
  const initial = useMemo(() => ({left: (diagramSize - viewWidth) / 2, top: (diagramSize - viewHeight) / 2,
    width: viewWidth, height: viewHeight}), [diagramSize, viewWidth, viewHeight]);
  const panX = (relationView?.center.x ?? 0) * graphZoom;
  const panY = (relationView?.center.y ?? 0) * graphZoom;
  const graphPanned = pannable && (panX !== 0 || panY !== 0);
  const visibleViewport = useMemo(() => ({...initial, left: initial.left + panX, top: initial.top + panY}), [initial, panX, panY]);
  const textScale = scaleTextWithZoom ? graphZoom : 1;
  const nodeScale = scaleTextWithZoom ? textScale : Math.max(0.55, Math.min(1, graphZoom * 2));
  const lineScale = scaleTextWithZoom ? textScale : Math.max(0.8, nodeScale);
  const nodeRem = rem * nodeScale;
  const textRem = rem * textScale;
  const shownGroups = useMemo(() => {
    let order = 0;
    return groups.map((group, groupIndex) => ({
      ...group, items: group.items.map((asset, index) => {
        const position = orbit?.groups[groupIndex].slots[index];
        const relation = assetId && position
          ? {id: asset.id, name: asset.name, position, label: relationLabels?.get(asset.id) ?? "",
            labelPosition: relationLabelPosition(position, textRem / graphZoom)} : null;
        return {asset, order: order++, position, relation,
          initial: !relation || !overflow || isRelationInViewport(relation.position, relation.labelPosition, diagramSize, initial, textRem),
        };
      }),
    }));
  }, [groups, orbit, assetId, relationLabels, overflow, diagramSize, initial, textRem, graphZoom]);
  const visibleGroups = useMemo(() => shownGroups.map(group => ({
    ...group, items: group.items.filter(({asset, relation, initial}) => !relation || asset.id === focusedPeerId
      || (graphPanned ? isRelationInViewport(relation.position, relation.labelPosition, diagramSize, visibleViewport, textRem) : initial)),
  })), [shownGroups, focusedPeerId, graphPanned, visibleViewport, diagramSize, textRem]);
  const visibleLabels = useMemo(() => {
    if (graphZoom >= textScale) return null;
    const visible = visibleGroups.flatMap(group => group.items.flatMap(({relation}) => relation ? [relation] : []));
    return layoutRelationLabels(visible, diagramSize, nodeRem, textRem, highlightedPeerId, focusedPeerId);
  }, [visibleGroups, diagramSize, nodeRem, textRem, graphZoom, textScale, highlightedPeerId, focusedPeerId]);
  const entranceOrder = useMemo(() => {
    const initiallyVisible = shownGroups.flatMap(group => group.items.filter(item => item.relation && item.initial));
    const count = initiallyVisible.length;
    return new Map(initiallyVisible.map(({asset}, index) => [
      asset.id, Math.floor(index * Math.min(entrancePhaseCount, count) / count),
    ]));
  }, [shownGroups]);
  const relationPhases = useMemo(() => {
    if (!assetId || !orbit) return [];
    const batches = Array.from({length: entrancePhaseCount + 1}, (): PositionedAsset[] => []);
    for (const group of visibleGroups) {
      for (const {asset, relation} of group.items) {
        if (relation) batches[entranceOrder.get(asset.id) ?? entrancePhaseCount].push(relation);
      }
    }
    return batches.map((items, phase) => ({
      phase, items, path: items.map(({position}) => relationSegment(position, diagramSize / 2, graphZoom, nodeRem)).join(""),
    }));
  }, [assetId, orbit, visibleGroups, entranceOrder, diagramSize, graphZoom, nodeRem]);
  const drawFullRelations = graphZoom > 1 && (overflow || graphPanned);
  const fullRelationPath = useMemo(() => {
    if (!drawFullRelations) return "";
    // Keep connections crossing the view when their nodes and labels are outside it.
    return shownGroups.flatMap(({items}) => items.flatMap(({relation}) => relation
      ? [relationSegment(relation.position, diagramSize / 2, graphZoom, nodeRem)] : [])).join("");
  }, [drawFullRelations, graphZoom, shownGroups, diagramSize, nodeRem]);
  const relationMessage = relationSnapshot?.loading ? t("正在读取资产关系…")
    : !relationSnapshot?.loaded ? t("资产关系读取失败")
    : !assetIds.length ? t("暂无资产关系") : !total ? t("没有符合筛选条件的关联资产") : null;
  const message = assetId ? relationMessage : !total ? t("暂无关联资产")
    : snapshot?.loading && !snapshot.loaded ? t("正在读取关联资产…") : !catalogReady ? t("资产目录暂不可用") : null;
  const sceneStyle = compact ? undefined : {width: diagramSize, height: diagramSize,
    // The world layer places the origin. Keep projected text and edges in screen pixels.
    transform: pannable ? `scale(${1 / graphZoom}) translate(-50%, -50%)` : undefined};
  const enteringCenter = !compact && Boolean(origin);
  const graphMoved = (pannable && relationMoved) || Boolean(activeCategorySelection);
  const style = {...sceneVariables,
    "--timeline-focus-text-scale": textScale,
    "--timeline-focus-node-scale": nodeScale,
    "--timeline-focus-line-scale": lineScale,
    "--timeline-focus-summary-width": `${diameter * 0.52}px`,
    "--timeline-focus-reveal-step": `${Math.min(65, 720 / Math.max(1, total - 1))}ms`,
    "--timeline-focus-dismiss-step": `${Math.min(22, 154 / Math.max(1, total - 1))}ms`,
  } as CSSProperties;

  useLayoutEffect(() => {
    if (selectedPeerId && (previousAsset.current !== focusedAsset || !highlightedPeerId)) setSelectedPeerId(null);
    if (previousAsset.current === focusedAsset || pannable && !relationViewport) return;
    previousAsset.current = focusedAsset;
    setCategorySelection(null);
    setFocusedPeerId(undefined);
    if (!focusedAsset) setScaleTextWithZoom(false);
    (focusedAsset ? summary.current : timelineCrumb.current)?.focus({preventScroll: true});
  }, [focusedAsset, highlightedPeerId, selectedPeerId, pannable, relationViewport]);

  useLayoutEffect(() => {
    const bar = breadcrumbBar.current;
    if (bar) bar.scrollLeft = bar.scrollWidth;
  }, [breadcrumbs, size.width]);

  useLayoutEffect(() => {
    const element = viewportElement.current;
    if (!element || !scrollableEvent) return;
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  }, [scrollableEvent, diagramSize, viewWidth, viewHeight]);

  useLayoutEffect(() => {
    if (centerMotion.current && origin && enteringCenter) return moveToCenter(centerMotion.current, origin);
  }, [assetId, enteringCenter, origin, relationViewport]);

  useLayoutEffect(() => {
    if (graphMoved) centerMotion.current?.getAnimations().forEach(animation => animation.cancel());
  }, [graphMoved]);

  useLayoutEffect(() => {
    if (!closing || !scene.current) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches || document.documentElement.dataset.uiMotion === "reduce" || document.hidden) {
      onExited();
      return;
    }
    const styles = getComputedStyle(scene.current);
    const duration = Number.parseFloat(styles.getPropertyValue("--timeline-focus-dismiss-duration"));
    const step = Number.parseFloat(styles.getPropertyValue("--timeline-focus-dismiss-step"));
    const easing = styles.getPropertyValue("--ui-ease-exit").trim();
    const nodes = [...scene.current.querySelectorAll<HTMLElement>(".timeline-focus-asset-node")];
    const animations: Animation[] = [];
    // Capture entry, drift and interaction scale before canceling them, so closing never jumps.
    const frames = nodes.map(node => {
      const style = getComputedStyle(node);
      const face = node.querySelector<HTMLElement>(".timeline-focus-asset-face")!;
      return {face, scale: getComputedStyle(face).scale, transform: style.transform, translate: style.translate, opacity: style.opacity,
        x: style.getPropertyValue("--timeline-focus-asset-offset-x").trim() || "0px",
        y: style.getPropertyValue("--timeline-focus-asset-offset-y").trim() || "0px"};
    });
    nodes.forEach((node, index) => {
      const frame = frames[index];
      node.getAnimations().forEach(animation => animation.cancel());
      node.style.animation = "none";
      frame.face.style.animation = "none";
      frame.face.style.transition = "none";
      frame.face.style.scale = frame.scale;
      animations.push(node.animate([
        {transform: frame.transform, translate: frame.translate, opacity: frame.opacity},
        {transform: compact ? "none" : `translate(${frame.x}, ${frame.y}) scale(0.22)`, translate: "none", opacity: 0},
      ], {duration, delay: (nodes.length - index - 1) * step, easing, fill: "both"}));
    });
    for (const ring of scene.current.querySelectorAll<HTMLElement>(".timeline-focus-orbit")) {
      const style = getComputedStyle(ring);
      const frame = {transform: style.transform, opacity: style.opacity};
      ring.getAnimations().forEach(animation => animation.cancel());
      ring.style.animation = "none";
      animations.push(ring.animate([frame, {transform: "scale(0.22)", opacity: 0}],
        {duration: duration + Math.max(0, nodes.length - 1) * step, easing, fill: "both"}));
    }
    let disposed = false;
    const finish = () => { if (!disposed) onExited(); };
    const skip = () => {
      if (motion.matches || document.documentElement.dataset.uiMotion === "reduce" || document.hidden) finish();
    };
    void Promise.allSettled(animations.map(animation => animation.finished)).then(finish);
    motion.addEventListener("change", skip);
    document.addEventListener("visibilitychange", skip);
    const observer = new MutationObserver(skip);
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ["data-ui-motion"]});
    return () => {
      disposed = true;
      animations.forEach(animation => animation.cancel());
      motion.removeEventListener("change", skip);
      document.removeEventListener("visibilitychange", skip);
      observer.disconnect();
    };
  }, [closing, compact, onExited]);

  function renderRelationLabel(id: string, name: string, label: string, position?: PositionedAsset["labelPosition"], phase?: number) {
    return <button key={id} type="button" data-canvas-interactive data-peer-id={id}
      className={compact ? "timeline-focus-relation-list-label" : "timeline-focus-relation-label"}
      data-relation-motion={phase === entrancePhaseCount ? "scroll" : undefined}
      aria-label={`${label}（${name}）`} aria-pressed={highlightedPeerId === id} title={label}
      style={position && {left: `${position.x}%`, top: `${position.y}%`}}
      onClick={event => {
        if (event.ctrlKey) return;
        setSelectedPeerId(current => current === id ? null : id);
      }}><span id={`${relationLabelId}-${id}`}>{label}</span></button>;
  }

  function trackFocusedPeer(target: EventTarget | null) {
    setFocusedPeerId(target instanceof Element && viewportElement.current?.contains(target)
      ? target.closest<HTMLElement>("[data-peer-id]")?.dataset.peerId : undefined);
  }

  const sceneContent = <div key={assetId ?? "event"} ref={scene} className="timeline-focus-scene"
    data-empty={!total || undefined} data-scrolled={graphMoved || undefined} style={sceneStyle}>
      {orbit?.rings.map(ring => <div key={ring.radius} className="timeline-focus-orbit" aria-hidden="true"
        style={{inset: diagramSize / 2 - ring.radius * graphZoom}} />)}
      {centerGroup && center ? <div className="timeline-focus-relation-center" data-canvas-interactive>
        <div ref={centerMotion} className="timeline-focus-relation-center-motion">
          <div className="timeline-focus-relation-center-node" data-highlighted={Boolean(highlightedPeerId) || undefined}
            style={{"--timeline-focus-category-color": centerGroup.color} as CSSProperties} title={center.title}>
            <span className="timeline-focus-asset-dot" aria-hidden="true" />
            <h2 ref={summary} className="timeline-focus-relation-name" tabIndex={-1}>{center.name}</h2>
            <span className="timeline-focus-asset-type">{center.detail}</span>
          </div>
        </div>
        {message && <p className="timeline-focus-message" role="status" title={relationSnapshot?.error ?? undefined}>{message}</p>}
      </div> : <div className="timeline-focus-event-summary">
        {children}
        {message && <p className="timeline-focus-message" role="status">{message}</p>}
      </div>}
      {total > 0 && <div className="timeline-focus-groups" data-canvas-interactive={compact || undefined}
        tabIndex={compact ? 0 : undefined} role="region" aria-label={assetId ? t("直接关联资产") : t("关联资产")}>
        {visibleGroups.map(({id, label, color, items}) => {
          return items.length > 0 && <section className="timeline-focus-group" key={id} aria-label={label}
            style={{"--timeline-focus-category-color": color} as CSSProperties}>
            <ul className="timeline-focus-asset-list">
              {items.map(({asset, order, position, initial}) => {
                const relation = relationLabels?.get(asset.id);
                const hasLabel = !visibleLabels || visibleLabels.has(asset.id);
                const nodeTitle = relation && !hasLabel ? `${asset.title} · ${relation}` : asset.title;
                const canInspect = Boolean(network && asset.known);
                const style: FocusNodeStyle = {
                  "--timeline-focus-asset-order": order,
                  ...(assetId ? {"--timeline-focus-relation-phase": entranceOrder.get(asset.id)} : {
                    "--timeline-focus-drift-x": `${3 + order % 3}px`,
                    "--timeline-focus-drift-y": `${4 + order % 2}px`,
                    "--timeline-focus-drift-duration": `${6000 + order % 5 * 600}ms`,
                    "--timeline-focus-drift-direction": order % 2 ? "reverse" : "normal",
                  }),
                  ...(position && {left: `${position.x}%`, top: `${position.y}%`,
                    "--timeline-focus-asset-offset-x": `${position.offsetX * graphZoom}px`,
                    "--timeline-focus-asset-offset-y": `${position.offsetY * graphZoom}px`}),
                };
                const face = <span className="timeline-focus-asset-face">
                  <span className="timeline-focus-asset-dot" aria-hidden="true" />
                  <span className="timeline-focus-asset-text">
                    <span className="timeline-focus-asset-name">{asset.name}</span>
                    <span className="timeline-focus-asset-type">{asset.detail}</span>
                  </span>
                </span>;
                return <li key={asset.id} className="timeline-focus-asset" style={style} data-peer-id={asset.id}
                  data-relation-motion={assetId && position && (initial ? "enter" : "scroll") || undefined}
                  data-highlighted={highlightedPeerId === asset.id || undefined}>
                  {canInspect ? <button type="button" className="timeline-focus-asset-node" data-canvas-interactive
                    title={nodeTitle} aria-label={t("查看「{name}」的资产关系", {values: {name: asset.name}})}
                    aria-describedby={relation && hasLabel ? `${relationLabelId}-${asset.id}` : undefined}
                    aria-description={hasLabel ? undefined : relation}
                    onClick={event => {
                      if (event.ctrlKey) return;
                      onFocusAsset(asset.id, compact ? null : assetPressOrigin(event.currentTarget));
                    }}>{face}</button>
                    : <div className="timeline-focus-asset-node" title={nodeTitle} onClick={!compact && !network ? playAssetPress : undefined}
                      onPointerEnter={event => { delete event.currentTarget.dataset.clicked; }}>{face}</div>}
                  {relation && compact && renderRelationLabel(asset.id, asset.name, relation)}
                </li>;
              })}
            </ul>
          </section>;
        })}
      </div>}
      {assetId && orbit && <div className="timeline-focus-relation-edges">
        {fullRelationPath && <svg className="timeline-focus-relation-lines" width="100%" height="100%" aria-hidden="true">
          <path className="timeline-focus-relation-line" d={fullRelationPath} />
        </svg>}
        {relationPhases.map(({phase, items, path}) => {
          const selected = items.find(({id}) => id === highlightedPeerId);
          return items.length > 0 && <div key={phase} className="timeline-focus-relation-phase"
            data-entrance={phase < entrancePhaseCount || undefined} data-highlighted={Boolean(selected) || undefined}
            style={{"--timeline-focus-relation-phase": phase} as CSSProperties}>
            <svg className="timeline-focus-relation-lines" width="100%" height="100%" aria-hidden="true">
              {!fullRelationPath && <path className="timeline-focus-relation-line" d={path} />}
              {selected && <path className="timeline-focus-relation-line" data-highlighted
                d={relationSegment(selected.position, diagramSize / 2, graphZoom, nodeRem)} />}
            </svg>
            {items.map(({id, name, label, labelPosition}) =>
              label && (!visibleLabels || visibleLabels.has(id)) && renderRelationLabel(id, name, label, labelPosition, phase))}
          </div>;
        })}
      </div>}
  </div>;

  const Surface = canvas.Surface;
  return <div className="timeline-focus-assets" style={style} data-compact={compact || undefined}
    data-relations={Boolean(assetId) || undefined} data-centering={enteringCenter || undefined}
    data-small-nodes={nodeScale < 0.8 && !scaleTextWithZoom || undefined}
    inert={closing} data-closing={closing || undefined}>
    <div className="timeline-focus-toolbar">
      <nav ref={breadcrumbBar} className="timeline-focus-breadcrumbs" aria-label={t("时间线浏览路径")} data-canvas-interactive>
        <ol>
          {breadcrumbs.map(({label, target}, index) => {
            const text = <span className="timeline-focus-crumb-label">{label}</span>;
            return <li key={index}>
              {index > 0 && <Icon name="chevronRight" size="small" />}
              {index === breadcrumbs.length - 1
                ? <span className="timeline-focus-crumb-current" aria-current="page" title={label}>{text}</span>
                : <Button ref={target === "timeline" ? timelineCrumb : undefined} variant="ghost" title={label}
                  onClick={() => onNavigate(target)}>{text}</Button>}
            </li>;
          })}
        </ol>
      </nav>
      {assetId && !closing && <TimelineRelationCategoryFilter t={t} key={assetId}
        categories={categoryGroups} value={categoryFilter} onChange={changeCategoryFilter} />}
    </div>
    <div ref={viewportElement} className="timeline-focus-viewport" data-overflow={scrollableEvent || undefined}
      data-pannable={pannable || undefined} data-canvas-interactive={scrollableEvent || undefined}
      tabIndex={scrollableEvent ? 0 : undefined} role={scrollableEvent ? "region" : undefined}
      aria-label={scrollableEvent ? t("事件与全部关联资产") : undefined}
      onFocus={pannable ? event => trackFocusedPeer(event.target) : undefined}
      onBlur={pannable ? event => trackFocusedPeer(event.relatedTarget) : undefined}
      onClick={scrollableEvent ? click => {
        if (click.button !== 0 || click.ctrlKey || click.detail > 1 || !(click.target instanceof Element)) return;
        const bounds = click.currentTarget.getBoundingClientRect();
        if (click.clientX >= bounds.left + click.currentTarget.clientWidth
          || click.clientY >= bounds.top + click.currentTarget.clientHeight) return;
        if (!click.target.closest(".timeline-focus-event, .timeline-focus-relation-center, .timeline-focus-asset, .timeline-focus-relation-label")) onBack();
      } : undefined}>
      {pannable ? relationViewport && <Surface viewport={relationViewport} active={!closing} grid="none"
        label={t("资产关系图")} panOnPrimaryDrag wheelOnWorldControls showControls={Boolean(controlsTarget)}
        controls={{label: t("关系图视图"), target: controlsTarget ?? undefined}}
        zoomControls={<TimelineTextZoomSwitch t={t} checked={scaleTextWithZoom} disabled={closing || Boolean(relationView?.disposed)}
          onChange={setScaleTextWithZoom} />}>
        {sceneContent}
      </Surface> : <div className="timeline-focus-stage" style={sceneStyle}>{sceneContent}</div>}
    </div>
    {pannable && <div ref={setControlsTarget} className="timeline-focus-zoom" />}
  </div>;
}
