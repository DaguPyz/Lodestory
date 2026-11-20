import type {Translate} from "@lodestory/sdk/i18n";
import {useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore} from "react";
import {Icon, IconButton, Select} from "@lodestory/ui";
import {createDialogDragController} from "@lodestory/ui/pointer-drag";
import type {HighlightInspection} from "./plainTextDriver";

type Point = {x: number; y: number};
const keyboardMoves: Partial<Record<string, Point>> = {
  ArrowLeft: {x: -1, y: 0}, ArrowRight: {x: 1, y: 0}, ArrowUp: {x: 0, y: -1}, ArrowDown: {x: 0, y: 1},
};
const inset = 8;

export function PlainTextHighlightCard({t, inspection, active, front, onRaise, onClose}: {
  t: Translate;
  inspection: HighlightInspection;
  active: boolean;
  front: boolean;
  onRaise(): void;
  onClose(restoreFocus: boolean): void;
}) {
  const {anchor, preview} = inspection;
  const entries = useSyncExternalStore(preview.subscribe, preview.getSnapshot);
  const [selected, setSelected] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const entry = entries.find(value => value.id === selected) ?? entries[0];
  const distinct = entries.length > 1;
  const available = entry !== undefined;
  const titleId = useId();
  const detailsId = useId();
  const card = useRef<HTMLElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const position = useRef<Point | undefined>(undefined);
  const movement = useRef<{
    drag: ReturnType<typeof createDialogDragController>;
    moveBy(x: number, y: number): void;
    reset(): void;
  } | undefined>(undefined);

  useEffect(() => {
    if (!available) onClose(false);
  }, [available, onClose]);

  useLayoutEffect(() => {
    const panel = card.current;
    const handle = header.current;
    const layer = panel?.parentElement;
    if (!active || !available || !panel || !handle || !layer) return;

    const constrain = ({x, y}: Point) => ({
      x: Math.max(inset, Math.min(x, layer.clientWidth - panel.offsetWidth - inset)),
      y: Math.max(inset, Math.min(y, layer.clientHeight - panel.offsetHeight - inset)),
    });
    const place = (point: Point) => {
      position.current = point;
      panel.style.left = `${point.x}px`;
      panel.style.top = `${point.y}px`;
    };
    const initialPosition = () => {
      const bounds = layer.getBoundingClientRect();
      const below = anchor.bottom - bounds.top + inset;
      const above = anchor.top - bounds.top - panel.offsetHeight - inset;
      return {x: anchor.left - bounds.left,
        y: below + panel.offsetHeight + inset > layer.clientHeight && above >= inset ? above : below};
    };
    const fit = () => {
      if (layer.clientWidth && layer.clientHeight) place(constrain(position.current ?? initialPosition()));
    };
    fit();
    const drag = createDialogDragController({target: handle, getPosition: () => position.current ?? initialPosition(),
      constrain, setPosition: place, onDraggingChange: dragging => { panel.toggleAttribute("data-dragging", dragging); }});
    movement.current = {
      drag,
      moveBy(x, y) {
        const current = position.current ?? initialPosition();
        place(constrain({x: current.x + x, y: current.y + y}));
      },
      reset() { place(constrain(initialPosition())); },
    };
    const observer = new ResizeObserver(fit);
    observer.observe(layer);
    observer.observe(panel);
    const cancel = () => { drag.cancel(); };
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      observer.disconnect();
      drag.dispose();
      panel.removeAttribute("data-dragging");
      movement.current = undefined;
    };
  }, [active, anchor, available]);

  if (!entry) return null;
  const summary = entry.description?.trim()
    ? <p className="plain-text-highlight-card-description">{entry.description}</p> : null;
  return <section className="plain-text-highlight-card" role="dialog" aria-labelledby={titleId} ref={card}
    data-front={front || undefined} onPointerDownCapture={onRaise} onFocusCapture={onRaise} onKeyDown={event => {
      if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!movement.current?.drag.cancel()) onClose(true);
    }}>
    <header>
      <div className="plain-text-highlight-card-handle" ref={header} tabIndex={0} role="group"
        title={t("拖动标题移动卡片")} aria-label={t("移动卡片 {title}，使用方向键", {values: {title: entry.title}})}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.currentTarget.focus({preventScroll: true});
          movement.current?.drag.pointerDown(event);
        }}
        onPointerMove={event => movement.current?.drag.pointerMove(event)}
        onPointerUp={event => movement.current?.drag.pointerUp(event)}
        onPointerCancel={event => movement.current?.drag.pointerCancel(event)}
        onLostPointerCapture={event => movement.current?.drag.lostPointerCapture(event)}
        onKeyDown={event => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || movement.current?.drag.isActive()) return;
          if (event.key === "Home") {
            event.preventDefault();
            movement.current?.reset();
            return;
          }
          const direction = keyboardMoves[event.key];
          if (!direction) return;
          event.preventDefault();
          const step = event.shiftKey ? 24 : 8;
          movement.current?.moveBy(direction.x * step, direction.y * step);
        }}>
        <h2 id={titleId}>{entry.title}</h2>
      </div>
      <IconButton label={expanded ? t("收起详情") : t("展开详情")} aria-expanded={expanded} aria-controls={detailsId}
        onClick={() => setExpanded(value => !value)}>
        <Icon name={expanded ? "chevronUp" : "chevronDown"} size="small" />
      </IconButton>
      <IconButton label={t("关闭卡片 {title}", {values: {title: entry.title}})} onClick={() => onClose(true)}><Icon name="close" size="small" /></IconButton>
    </header>
    {!expanded && summary && <div className="plain-text-highlight-card-body" role="region" aria-label={t("资产简介")} tabIndex={0}>
      {summary}
    </div>}
    <div id={detailsId} hidden={!expanded} className="plain-text-highlight-card-body" role="region" aria-label={t("卡片详情")} tabIndex={0}>
      {expanded && <>
        {distinct ? <Select aria-label={t("选择同名资产")} value={entry.id} onValueChange={setSelected}
          options={entries.map(item => ({value: item.id, label: item.subtitle ? `${item.title} · ${item.subtitle}` : item.title}))} />
          : entry.subtitle && <p className="plain-text-highlight-card-category">{entry.subtitle}</p>}
        {summary}
        {entry.sections?.map(section => <div className="plain-text-highlight-card-section" key={section.id}>
          {section.title && <h3>{section.title}</h3>}
          <dl>{section.fields.map(field => <div key={field.id}>
            <dt>{field.label}</dt><dd>{field.value}</dd>
          </div>)}</dl>
        </div>)}
      </>}
    </div>
  </section>;
}
