import {useLayoutEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode} from "react";
import type {AssetCatalog, AssetCatalogAsset, AssetCatalogSnapshot} from "@lodestory/sdk/asset-catalog";
import {Button, Icon} from "@lodestory/ui";
import type {TimelineEvent} from "./timelineEventStore";
import {getTimelineAssetOrbit, timelineFocusEventCenter} from "./timelineAssetOrbit";
import "./timeline-focus-assets.css";

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

type FocusAsset = {id: string; name: string; detail: string; title: string};
type FocusGroup = {id: string; label: string; color: string; rank: number; items: FocusAsset[]};

// Suggested colors and ordering apply only when the project has these templates.
const preferredGroups = [
  {label: "人物", color: "var(--timeline-focus-gold)"},
  {label: "势力", color: "var(--ui-category-2-foreground)"},
  {label: "地点", color: "var(--ui-category-1-foreground)"},
];
const categoryColors = [3, 4, 5, 6, 1, 2].map(index => `var(--ui-category-${index}-foreground)`);
const sceneInset = {top: 56, bottom: 72, horizontal: 24};
const sceneVariables = {
  "--timeline-focus-inset-top": `${sceneInset.top}px`,
  "--timeline-focus-inset-bottom": `${sceneInset.bottom}px`,
  "--timeline-focus-inset-inline": `${sceneInset.horizontal}px`,
  "--timeline-focus-event-x": `${timelineFocusEventCenter.x}%`,
  "--timeline-focus-event-y": `${timelineFocusEventCenter.y}%`,
} as CSSProperties;

function playAssetPress(event: MouseEvent<HTMLDivElement>) {
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

function groupAssets(ids: readonly string[], snapshot: AssetCatalogSnapshot | null, available: boolean) {
  if (!ids.length) return [];
  const assets = new Map<string, AssetCatalogAsset>();
  for (const asset of snapshot?.assets ?? []) assets.set(asset.id, asset);
  const types = new Map(snapshot?.types.map((type, index) => [type.id, {type, index}]));
  const unknown = "未知分类";
  const unclassified = "未分类";
  const unavailable = available ? "失效关联" : "待确认关联";
  const groups = new Map<string, FocusGroup>();
  for (const id of ids) {
    const asset = assets.get(id);
    const template = asset?.typeId ? types.get(asset.typeId) : undefined;
    const type = template?.type;
    const label = type?.name ?? (asset ? (asset.typeId ? unknown : unclassified) : unavailable);
    const groupId = type?.id ?? (asset ? (asset.typeId ? unknown : unclassified) : unavailable);
    let group = groups.get(groupId);
    if (!group) {
      const sector = preferredGroups.findIndex(group => group.label === type?.name);
      const color = preferredGroups[sector]?.color
        ?? (template ? categoryColors[template.index % categoryColors.length] : "var(--ui-text-muted)");
      group = {id: groupId, label, color,
        rank: sector >= 0 ? sector : preferredGroups.length + (template?.index ?? types.size), items: []};
      groups.set(groupId, group);
    }
    const name = asset?.name ?? (available ? "资产不可用" : "资产待确认");
    const detail = !asset ? id.slice(0, 8) : type?.status === "archived" ? `${label}（已归档）` : label;
    group.items.push({id, name, detail, title: asset?.description ? `${name} · ${asset.description}` : asset ? name : id});
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank);
}

export function TimelineFocusAssets({event, catalog, size, closing, onExit, onExited, children}: {
  event: TimelineEvent;
  catalog: AssetCatalog | null;
  size: Readonly<{width: number; height: number}>;
  closing: boolean;
  onExit(): void;
  onExited(): void;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore<AssetCatalogSnapshot | null>(
    catalog?.subscribe ?? emptySubscribe, catalog?.getSnapshot ?? emptySnapshot, emptySnapshot,
  );
  const catalogReady = Boolean(snapshot?.loaded && !snapshot.blocked && !snapshot.error);
  const groups = useMemo(() => groupAssets(event.assetIds, snapshot, catalogReady), [event.assetIds, snapshot, catalogReady]);
  const scene = useRef<HTMLDivElement>(null);
  const scrollport = useRef<HTMLDivElement>(null);
  const total = event.assetIds.length;
  const diameter = Math.min(size.width - 2 * sceneInset.horizontal,
    size.height - sceneInset.top - sceneInset.bottom, 600);
  const sceneSize = {width: diameter, height: diameter};
  const compact = diameter < 440;
  let start = 0;
  const shownGroups = groups.map(group => {
    const first = start;
    start += group.items.length;
    return {...group, first};
  });
  const orbit = compact ? null : getTimelineAssetOrbit(shownGroups.map(group =>
    ({count: group.items.length})), sceneSize);
  const diagramSize = orbit?.diameter ?? diameter;
  const overflow = !compact && (diagramSize > size.width - 2 * sceneInset.horizontal
    || diagramSize > size.height - sceneInset.top - sceneInset.bottom);
  const message = !total ? "暂无关联资产"
    : snapshot?.loading && !snapshot.loaded ? "正在读取关联资产…"
    : !catalogReady ? "资产目录暂不可用" : null;
  const sceneStyle = compact ? undefined : {width: diagramSize, height: diagramSize};
  const style = {...sceneVariables,
    "--timeline-focus-summary-width": `${diameter * 0.52}px`,
    "--timeline-focus-reveal-step": `${Math.min(65, 720 / Math.max(1, total - 1))}ms`,
    "--timeline-focus-dismiss-step": `${Math.min(22, 154 / Math.max(1, total - 1))}ms`,
  } as CSSProperties;

  useLayoutEffect(() => {
    const element = scrollport.current;
    if (!element) return;
    element.scrollLeft = Math.max(0, (element.scrollWidth - element.clientWidth) / 2);
    element.scrollTop = Math.max(0, (element.scrollHeight - element.clientHeight) / 2);
  }, [diagramSize, size.width, size.height, compact]);

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

  return <div className="timeline-focus-assets" style={style} data-compact={compact || undefined}
    inert={closing} data-closing={closing || undefined}>
    <div className="timeline-focus-toolbar" data-canvas-interactive>
      <Button variant="ghost" onClick={onExit}><Icon name="arrowLeft" />返回时间线</Button>
    </div>
    <div ref={scrollport} className="timeline-focus-viewport" data-overflow={overflow || undefined}
      data-canvas-interactive={overflow || undefined} tabIndex={overflow ? 0 : undefined}
      role={overflow ? "region" : undefined} aria-label={overflow ? "事件与全部关联资产" : undefined}
      onClick={click => {
        if (!overflow || click.button !== 0 || click.ctrlKey || click.detail > 1 || !(click.target instanceof Element)) return;
        const bounds = click.currentTarget.getBoundingClientRect();
        if (click.clientX >= bounds.left + click.currentTarget.clientWidth
          || click.clientY >= bounds.top + click.currentTarget.clientHeight) return;
        if (!click.target.closest(".timeline-focus-event, .timeline-focus-asset")) onExit();
      }}>
    <div className="timeline-focus-stage" style={sceneStyle}>
    <div ref={scene} className="timeline-focus-scene" data-empty={!total || undefined} style={sceneStyle}>
      {orbit?.rings.map(ring => <div key={ring.radius} className="timeline-focus-orbit" aria-hidden="true"
        style={{inset: (diagramSize - ring.radius * 2) / 2}} />)}
      <div className="timeline-focus-event-summary">
        {children}
        {message && <p className="timeline-focus-message" role="status">{message}</p>}
      </div>
      {total > 0 && <div className="timeline-focus-groups" data-canvas-interactive={compact || undefined}
        tabIndex={compact ? 0 : undefined} role="region" aria-label="关联资产">
        {shownGroups.map(({id, label, color, items, first}, groupIndex) => {
          const layout = orbit?.groups[groupIndex];
          return <section className="timeline-focus-group" key={id} aria-label={label}
            style={{"--timeline-focus-category-color": color} as CSSProperties}>
            <ul className="timeline-focus-asset-list">
              {items.map((asset, index) => {
                const position = layout?.slots[index];
                const order = first + index;
                const style = {
                  "--timeline-focus-asset-order": order,
                  "--timeline-focus-drift-x": `${3 + order % 3}px`,
                  "--timeline-focus-drift-y": `${4 + order % 2}px`,
                  "--timeline-focus-drift-duration": `${6000 + order % 5 * 600}ms`,
                  "--timeline-focus-drift-direction": order % 2 ? "reverse" : "normal",
                  ...(position && {left: `${position.x}%`, top: `${position.y}%`,
                    "--timeline-focus-asset-offset-x": `${position.offsetX}px`,
                    "--timeline-focus-asset-offset-y": `${position.offsetY}px`}),
                } as CSSProperties;
                return <li key={asset.id} className="timeline-focus-asset" style={style} title={asset.title}>
                  <div className="timeline-focus-asset-node" onClick={compact ? undefined : playAssetPress}
                    onPointerEnter={event => { delete event.currentTarget.dataset.clicked; }}>
                    <div className="timeline-focus-asset-face">
                      <span className="timeline-focus-asset-dot" aria-hidden="true" />
                      <div className="timeline-focus-asset-text">
                        <span className="timeline-focus-asset-name">{asset.name}</span>
                        <span className="timeline-focus-asset-type">{asset.detail}</span>
                      </div>
                    </div>
                  </div>
                </li>;
              })}
            </ul>
          </section>;
        })}
      </div>}
    </div>
    </div>
    </div>
  </div>;
}
