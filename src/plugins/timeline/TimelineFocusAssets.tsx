import {useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode} from "react";
import type {AssetCatalog, AssetCatalogSnapshot} from "@lodestory/sdk/asset-catalog";
import type {AssetRelationNetwork, AssetRelationSnapshot} from "@lodestory/sdk/asset-relations";
import {Button, Icon} from "@lodestory/ui";
import type {TimelineEvent} from "./timelineEventStore";
import {getTimelineAssetOrbit, isRelationInViewport, relationLabelPosition, timelineFocusEventCenter, type OrbitSlot} from "./timelineAssetOrbit";
import {groupFocusAssets, relationLabelsByAsset, type FocusAsset} from "./timelineFocusAssetData";
import {useTimelineRelationViewport} from "./useTimelineRelationViewport";
import "./timeline-focus-assets.css";

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;
const fontSizeInPixels = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

export type AssetClickPosition = Readonly<{x: number; y: number; width: number}>;

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

type PositionedAsset = Readonly<{asset: FocusAsset; position: OrbitSlot; labelPosition: {x: number; y: number}}>;
type FocusNodeStyle = CSSProperties & Partial<Record<`--timeline-focus-${string}`, string | number>>;

function relationSegment({offsetX, offsetY}: OrbitSlot, center: number, rem: number) {
  const ratio = 1 - 2.2 * rem / Math.hypot(offsetX, offsetY);
  return `M${center} ${center}L${center - offsetX * ratio} ${center - offsetY * ratio}`;
}

export function TimelineFocusAssets({event, catalog, network, assetId, origin, size, closing, backLabel, onFocusAsset, onExit, onExited, children}: {
  event: TimelineEvent;
  catalog: AssetCatalog | null;
  network: AssetRelationNetwork | null;
  assetId?: string;
  origin?: AssetClickPosition | null;
  size: Readonly<{width: number; height: number}>;
  closing: boolean;
  backLabel: string;
  onFocusAsset(id: string, origin: AssetClickPosition | null): void;
  onExit(): void;
  onExited(): void;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore<AssetCatalogSnapshot | null>(
    catalog?.subscribe ?? emptySubscribe, catalog?.getSnapshot ?? emptySnapshot, emptySnapshot,
  );
  const activeNetwork = assetId ? network : null;
  const relationSnapshot = useSyncExternalStore<AssetRelationSnapshot | null>(
    activeNetwork?.subscribe ?? emptySubscribe, activeNetwork?.getSnapshot ?? emptySnapshot, emptySnapshot,
  );
  const relations = assetId && relationSnapshot?.loaded ? activeNetwork?.getRelations(assetId) : undefined;
  const relationLabels = useMemo(() => assetId && relations ? relationLabelsByAsset(assetId, relations) : null, [assetId, relations]);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const highlightedPeerId = selectedPeerId && relationLabels?.has(selectedPeerId) ? selectedPeerId : null;
  const assetIds = useMemo(() => assetId ? [...(relationLabels?.keys() ?? [])] : event.assetIds, [assetId, relationLabels, event.assetIds]);
  const catalogReady = Boolean(snapshot?.loaded && !snapshot.blocked && !snapshot.error);
  const groups = useMemo(() => groupFocusAssets(assetIds, snapshot), [assetIds, snapshot]);
  const centerGroup = useMemo(() => assetId ? groupFocusAssets([assetId], snapshot)[0] : undefined, [assetId, snapshot]);
  const center = centerGroup?.items[0];
  const scene = useRef<HTMLDivElement>(null);
  const scrollport = useRef<HTMLDivElement>(null);
  const relationLabelId = useId();
  const centerMotion = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLHeadingElement>(null);
  const toolbarBack = useRef<HTMLButtonElement>(null);
  const previousAsset = useRef(assetId);
  const total = assetIds.length;
  const diameter = Math.min(size.width - 2 * sceneInset.horizontal,
    size.height - sceneInset.top - sceneInset.bottom, 600);
  const rem = assetId ? fontSizeInPixels() : 16;
  const compact = diameter < 440 * rem / 16;
  const orbit = useMemo(() => compact ? null : getTimelineAssetOrbit(groups.map(group => ({count: group.items.length})),
    {width: diameter, height: diameter}, assetId ? {spacing: 12 * rem, offsetRings: true} : undefined),
  [groups, diameter, compact, assetId, rem]);
  const diagramSize = orbit?.diameter ?? diameter;
  const overflow = !compact && (diagramSize > size.width - 2 * sceneInset.horizontal
    || diagramSize > size.height - sceneInset.top - sceneInset.bottom);
  const {initial, scrolled} = useTimelineRelationViewport(scrollport, {
    assetId, diameter: diagramSize, overflow, compact,
    width: size.width - 2 * sceneInset.horizontal, height: size.height - sceneInset.top - sceneInset.bottom,
  });
  const shownGroups = useMemo(() => {
    let order = 0;
    return groups.map((group, groupIndex) => ({
      ...group, items: group.items.map((asset, index) => {
        const position = orbit?.groups[groupIndex].slots[index];
        const relation = assetId && position ? {asset, position, labelPosition: relationLabelPosition(position, rem)} : null;
        return {asset, order: order++, position, relation,
          initial: !relation || !overflow || isRelationInViewport(relation.position, relation.labelPosition, diagramSize, initial, rem),
        };
      }),
    }));
  }, [groups, orbit, assetId, overflow, diagramSize, initial, rem]);
  const visibleGroups = useMemo(() => shownGroups.map(group => ({
    ...group, items: scrolled ? group.items.filter(({asset, relation}) => !relation || asset.id === scrolled.focusedPeerId
      || isRelationInViewport(relation.position, relation.labelPosition, diagramSize, scrolled.viewport, rem))
      : group.items.filter(item => item.initial),
  })), [shownGroups, scrolled, diagramSize, rem]);
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
      phase, items, path: items.map(({position}) => relationSegment(position, diagramSize / 2, rem)).join(""),
    }));
  }, [assetId, orbit, visibleGroups, entranceOrder, diagramSize, rem]);
  const relationMessage = relationSnapshot?.loading ? "正在读取资产关系…"
    : !relationSnapshot?.loaded ? "资产关系读取失败"
    : !total ? "暂无资产关系" : null;
  const message = assetId ? relationMessage : !total ? "暂无关联资产"
    : snapshot?.loading && !snapshot.loaded ? "正在读取关联资产…" : !catalogReady ? "资产目录暂不可用" : null;
  const sceneStyle = compact ? undefined : {width: diagramSize, height: diagramSize};
  const enteringCenter = !compact && Boolean(origin);
  const style = {...sceneVariables,
    "--timeline-focus-summary-width": `${diameter * 0.52}px`,
    "--timeline-focus-reveal-step": `${Math.min(65, 720 / Math.max(1, total - 1))}ms`,
    "--timeline-focus-dismiss-step": `${Math.min(22, 154 / Math.max(1, total - 1))}ms`,
  } as CSSProperties;

  useLayoutEffect(() => {
    if (selectedPeerId && (previousAsset.current !== assetId || !relationLabels?.has(selectedPeerId))) setSelectedPeerId(null);
    if (previousAsset.current === assetId) return;
    previousAsset.current = assetId;
    (assetId ? summary.current : toolbarBack.current)?.focus({preventScroll: true});
  }, [assetId, relationLabels, selectedPeerId]);

  useLayoutEffect(() => {
    if (centerMotion.current && origin && enteringCenter) return moveToCenter(centerMotion.current, origin);
  }, [assetId, enteringCenter, origin]);

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

  function renderRelationLabel(asset: FocusAsset, label: string, position?: PositionedAsset["labelPosition"], phase?: number) {
    return <button key={asset.id} type="button" data-canvas-interactive data-peer-id={asset.id}
      className={compact ? "timeline-focus-relation-list-label" : "timeline-focus-relation-label"}
      data-relation-motion={phase === entrancePhaseCount ? "scroll" : undefined}
      aria-label={`${label}（${asset.name}）`} aria-pressed={highlightedPeerId === asset.id} title={label}
      style={position && {left: `${position.x}%`, top: `${position.y}%`}}
      onClick={event => {
        if (event.ctrlKey) return;
        setSelectedPeerId(current => current === asset.id ? null : asset.id);
      }}><span id={`${relationLabelId}-${asset.id}`}>{label}</span></button>;
  }

  return <div className="timeline-focus-assets" style={style} data-compact={compact || undefined}
    data-relations={Boolean(assetId) || undefined} data-centering={enteringCenter || undefined}
    inert={closing} data-closing={closing || undefined}>
    <div className="timeline-focus-toolbar" data-canvas-interactive>
      <Button ref={toolbarBack} variant="ghost" onClick={onExit}><Icon name="arrowLeft" />{backLabel}</Button>
    </div>
    <div ref={scrollport} className="timeline-focus-viewport" data-overflow={overflow || undefined}
      data-canvas-interactive={overflow || undefined} tabIndex={overflow ? 0 : undefined}
      role={overflow ? "region" : undefined} aria-label={overflow ? assetId ? "资产与全部关系" : "事件与全部关联资产" : undefined}
      onClick={click => {
        if (!overflow || click.button !== 0 || click.ctrlKey || click.detail > 1 || !(click.target instanceof Element)) return;
        const bounds = click.currentTarget.getBoundingClientRect();
        if (click.clientX >= bounds.left + click.currentTarget.clientWidth
          || click.clientY >= bounds.top + click.currentTarget.clientHeight) return;
        if (!click.target.closest(".timeline-focus-event, .timeline-focus-relation-center, .timeline-focus-asset, .timeline-focus-relation-label")) onExit();
      }}>
    <div key={assetId ?? "event"} className="timeline-focus-stage" style={sceneStyle}>
    <div ref={scene} className="timeline-focus-scene" data-empty={!total || undefined} data-scrolled={Boolean(scrolled) || undefined} style={sceneStyle}>
      {orbit?.rings.map(ring => <div key={ring.radius} className="timeline-focus-orbit" aria-hidden="true"
        style={{inset: (diagramSize - ring.radius * 2) / 2}} />)}
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
        tabIndex={compact ? 0 : undefined} role="region" aria-label={assetId ? "直接关联资产" : "关联资产"}>
        {visibleGroups.map(({id, label, color, items}) => {
          return items.length > 0 && <section className="timeline-focus-group" key={id} aria-label={label}
            style={{"--timeline-focus-category-color": color} as CSSProperties}>
            <ul className="timeline-focus-asset-list">
              {items.map(({asset, order, position, initial}) => {
                const labels = relationLabels?.get(asset.id);
                const label = compact && labels?.join(" / ");
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
                    "--timeline-focus-asset-offset-x": `${position.offsetX}px`,
                    "--timeline-focus-asset-offset-y": `${position.offsetY}px`}),
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
                    title={asset.title} aria-label={`查看「${asset.name}」的资产关系`}
                    aria-describedby={labels?.length ? `${relationLabelId}-${asset.id}` : undefined}
                    onClick={event => {
                      if (event.ctrlKey) return;
                      onFocusAsset(asset.id, compact ? null : assetPressOrigin(event.currentTarget));
                    }}>{face}</button>
                    : <div className="timeline-focus-asset-node" title={asset.title} onClick={!compact && !network ? playAssetPress : undefined}
                      onPointerEnter={event => { delete event.currentTarget.dataset.clicked; }}>{face}</div>}
                  {label && compact && renderRelationLabel(asset, label)}
                </li>;
              })}
            </ul>
          </section>;
        })}
      </div>}
      {assetId && orbit && <div className="timeline-focus-relation-edges">
        {relationPhases.map(({phase, items, path}) => {
          const selected = items.find(({asset}) => asset.id === highlightedPeerId);
          return items.length > 0 && <div key={phase} className="timeline-focus-relation-phase"
            data-entrance={phase < entrancePhaseCount || undefined} data-highlighted={Boolean(selected) || undefined}
            style={{"--timeline-focus-relation-phase": phase} as CSSProperties}>
            <svg className="timeline-focus-relation-lines" width="100%" height="100%" aria-hidden="true">
              <path className="timeline-focus-relation-line" d={path} />
              {selected && <path className="timeline-focus-relation-line" data-highlighted
                d={relationSegment(selected.position, diagramSize / 2, rem)} />}
            </svg>
            {items.map(({asset, labelPosition}) => {
              const label = relationLabels?.get(asset.id)?.join(" / ");
              return label && renderRelationLabel(asset, label, labelPosition, phase);
            })}
          </div>;
        })}
      </div>}
    </div>
    </div>
    </div>
  </div>;
}
