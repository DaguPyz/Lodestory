import {useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode} from "react";
import type {AssetCatalog, AssetCatalogSnapshot} from "@lodestory/sdk/asset-catalog";
import type {AssetRelationNetwork, AssetRelationSnapshot} from "@lodestory/sdk/asset-relations";
import {Button, Icon} from "@lodestory/ui";
import type {TimelineEvent} from "./timelineEventStore";
import {getTimelineAssetOrbit, timelineFocusEventCenter} from "./timelineAssetOrbit";
import {groupFocusAssets, relationLabelsByAsset} from "./timelineFocusAssetData";
import "./timeline-focus-assets.css";

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;
const fontSizeInPixels = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

export type AssetClickPosition = Readonly<{x: number; y: number; width: number}>;

const sceneInset = {top: 56, bottom: 72, horizontal: 24};
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
  const sceneSize = {width: diameter, height: diameter};
  const compact = diameter < 440 * rem / 16;
  let start = 0;
  const shownGroups = groups.map(group => {
    const first = start;
    start += group.items.length;
    return {...group, first};
  });
  const orbit = compact ? null : getTimelineAssetOrbit(shownGroups.map(group =>
    ({count: group.items.length})), sceneSize, assetId ? {spacing: 12 * rem, offsetRings: true} : undefined);
  const diagramSize = orbit?.diameter ?? diameter;
  const overflow = !compact && (diagramSize > size.width - 2 * sceneInset.horizontal
    || diagramSize > size.height - sceneInset.top - sceneInset.bottom);
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
    const element = scrollport.current;
    if (!element) return;
    element.scrollLeft = Math.max(0, (element.scrollWidth - element.clientWidth) / 2);
    element.scrollTop = Math.max(0, (element.scrollHeight - element.clientHeight) / 2);
  }, [assetId, diagramSize, size.width, size.height, compact]);

  useLayoutEffect(() => {
    if (previousAsset.current === assetId) return;
    previousAsset.current = assetId;
    (assetId ? summary.current : toolbarBack.current)?.focus({preventScroll: true});
  }, [assetId]);

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
        if (!click.target.closest(".timeline-focus-event, .timeline-focus-relation-center, .timeline-focus-asset, .timeline-focus-relation-edge")) onExit();
      }}>
    <div key={assetId ?? "event"} className="timeline-focus-stage" style={sceneStyle}>
    <div ref={scene} className="timeline-focus-scene" data-empty={!total || undefined} style={sceneStyle}>
      {orbit?.rings.map(ring => <div key={ring.radius} className="timeline-focus-orbit" aria-hidden="true"
        style={{inset: (diagramSize - ring.radius * 2) / 2}} />)}
      {centerGroup && center ? <div className="timeline-focus-relation-center" data-canvas-interactive>
        <div ref={centerMotion} className="timeline-focus-relation-center-motion">
          <div className="timeline-focus-relation-center-node" style={{"--timeline-focus-category-color": centerGroup.color} as CSSProperties} title={center.title}>
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
        {shownGroups.map(({id, label, color, items, first}, groupIndex) => {
          const layout = orbit?.groups[groupIndex];
          return <section className="timeline-focus-group" key={id} aria-label={label}
            style={{"--timeline-focus-category-color": color} as CSSProperties}>
            <ul className="timeline-focus-asset-list">
              {items.map((asset, index) => {
                const position = layout?.slots[index];
                const order = first + index;
                const labels = relationLabels?.get(asset.id);
                const label = labels?.join(" / ");
                const canInspect = Boolean(network && asset.known);
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
                const face = <span className="timeline-focus-asset-face">
                  <span className="timeline-focus-asset-dot" aria-hidden="true" />
                  <span className="timeline-focus-asset-text">
                    <span className="timeline-focus-asset-name">{asset.name}</span>
                    <span className="timeline-focus-asset-type">{asset.detail}</span>
                  </span>
                </span>;
                return <li key={asset.id} className="timeline-focus-asset" style={style}>
                  {canInspect ? <button type="button" className="timeline-focus-asset-node" data-canvas-interactive
                    title={asset.title} aria-label={`查看「${asset.name}」的资产关系`}
                    aria-describedby={label ? `${relationLabelId}-${asset.id}` : undefined}
                    onClick={event => {
                      if (event.ctrlKey) return;
                      onFocusAsset(asset.id, compact ? null : assetPressOrigin(event.currentTarget));
                    }}>{face}</button>
                    : <div className="timeline-focus-asset-node" title={asset.title} onClick={!compact && !network ? playAssetPress : undefined}
                      onPointerEnter={event => { delete event.currentTarget.dataset.clicked; }}>{face}</div>}
                  {label && compact && <span id={`${relationLabelId}-${asset.id}`} className="timeline-focus-relation-list-label">{label}</span>}
                </li>;
              })}
            </ul>
          </section>;
        })}
      </div>}
      {assetId && orbit && <div className="timeline-focus-relation-edges">
        {shownGroups.flatMap((group, groupIndex) => group.items.map((asset, index) => {
          const {x, y, offsetX, offsetY} = orbit.groups[groupIndex].slots[index];
          const length = Math.hypot(offsetX, offsetY);
          const angle = Math.atan2(-offsetY, -offsetX);
          // Place labels between rings, close enough to identify their own circle.
          const labelPosition = (length - 5.5 * rem) / length;
          const label = relationLabels?.get(asset.id)?.join(" / ");
          return <div key={asset.id} className="timeline-focus-relation-edge"
            style={{"--timeline-focus-asset-order": group.first + index} as CSSProperties}>
            <span className="timeline-focus-relation-line" aria-hidden="true"
              style={{width: `calc(${length}px - 2.2rem)`, rotate: `${angle}rad`}} />
            <span id={`${relationLabelId}-${asset.id}`} data-canvas-interactive className="timeline-focus-relation-label" title={label}
              style={{left: `${50 + (x - 50) * labelPosition}%`, top: `${50 + (y - 50) * labelPosition}%`}}>{label}</span>
          </div>;
        }))}
      </div>}
    </div>
    </div>
    </div>
  </div>;
}
