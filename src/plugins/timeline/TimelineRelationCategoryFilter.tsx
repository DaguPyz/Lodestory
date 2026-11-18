import {memo, useId, useLayoutEffect, useRef, useState} from "react";
import {Popover} from "@base-ui/react/popover";
import {Icon, IconButton, useInteractionRef} from "@lodestory/ui";
import "./timeline-events.css";

const modes = {
  all: {label: "全部", icon: "layers", tooltip: "显示全部分类"},
  exclude: {label: "排除", icon: "minus", tooltip: "排除所选分类"},
  include: {label: "包含", icon: "plus", tooltip: "只显示所选分类"},
} as const;
const filterLabel = "分类筛选";

export type RelationCategoryFilter = Readonly<{
  mode: keyof typeof modes;
  categoryIds: ReadonlySet<string>;
}>;

export const allRelationCategories: RelationCategoryFilter = {mode: "all", categoryIds: new Set()};

export const TimelineRelationCategoryFilter = memo(function TimelineRelationCategoryFilter({categories, value, onChange}: {
  categories: readonly {id: string; label: string}[];
  value: RelationCategoryFilter;
  onChange(value: RelationCategoryFilter): void;
}) {
  const filter = useRef<HTMLDivElement>(null);
  const modeStrip = useRef<HTMLDivElement>(null);
  const [modeStripState, setModeStripState] = useState<"closed" | "open" | "closing">("closed");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [density, setDensity] = useState<string>();
  const active = value.mode !== "all";
  const disabled = !categories.length && !active;
  const showModes = modeStripState === "open" && !disabled;
  const showOptions = showModes && optionsOpen && active;
  const modeInteractionRef = useInteractionRef<HTMLDivElement>(showModes, "popover");
  const optionInteractionRef = useInteractionRef<HTMLDivElement>(showOptions, "popover");
  const categoryLabelId = useId();
  const count = categories.reduce((total, category) => total + Number(value.categoryIds.has(category.id)), 0);
  const categoryHint = !categories.length ? "暂无关联分类"
    : value.mode === "exclude" ? "隐藏所选分类"
    : count ? "只显示所选分类" : "勾选要显示的分类";

  useLayoutEffect(() => {
    if (!disabled) return;
    setModeStripState("closed");
    setOptionsOpen(false);
  }, [disabled]);

  function toggle(categoryId: string, checked: boolean) {
    const categoryIds = new Set(value.categoryIds);
    if (checked) categoryIds.add(categoryId);
    else categoryIds.delete(categoryId);
    onChange({...value, categoryIds});
  }

  return <div ref={filter} className="timeline-focus-filter" data-canvas-interactive
    data-modes-visible={(!disabled && modeStripState !== "closed") || undefined}>
    <Popover.Root open={showModes} onOpenChange={next => {
      if (next) setDensity(filter.current?.closest<HTMLElement>("[data-ui-density]")?.dataset.uiDensity);
      else setOptionsOpen(false);
      setModeStripState(next ? "open" : "closing");
    }} onOpenChangeComplete={open => {
      if (!open) setModeStripState(state => state === "closing" ? "closed" : state);
    }}>
      <Popover.Trigger disabled={disabled} data-filter-active={active || undefined}
        render={<IconButton label={active ? `${filterLabel}，${modes[value.mode].label} ${count} 类` : filterLabel} />}>
        <Icon name="slidersHorizontal" size="small" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner ref={modeStrip} className="timeline-event-popup-positioner" data-ui-density={density}
          side="left" sideOffset={4} collisionPadding={8}>
          <Popover.Popup className="timeline-event-popup timeline-focus-filter-modes" ref={modeInteractionRef} aria-label="筛选方式">
            <Popover.Root open={showOptions} onOpenChange={setOptionsOpen}>
              <IconButton label={modes.all.label} tooltip={modes.all.tooltip} aria-pressed={value.mode === "all"} onClick={() => {
                if (active) onChange(allRelationCategories);
                setOptionsOpen(false);
              }}>
                <Icon name={modes.all.icon} size="small" />
              </IconButton>
              {(["exclude", "include"] as const).map(mode => <Popover.Trigger key={mode} aria-pressed={value.mode === mode}
                render={<IconButton label={modes[mode].label} tooltip={modes[mode].tooltip} />}
                onClick={() => {
                  if (value.mode !== mode) onChange({...value, mode});
                }}>
                <Icon name={modes[mode].icon} size="small" />
              </Popover.Trigger>)}
              {active && <Popover.Portal>
                <Popover.Positioner anchor={modeStrip} className="timeline-event-popup-positioner" data-ui-density={density}
                  align="end" sideOffset={4} collisionPadding={8}>
                  <Popover.Popup className="timeline-event-popup timeline-focus-filter-popup" ref={optionInteractionRef}
                    aria-label={`${modes[value.mode].label}分类`}>
                    <div role="group" aria-labelledby={categoryLabelId}>
                      <p className="timeline-focus-filter-caption" id={categoryLabelId}>{categoryHint}</p>
                      {categories.map(category => <label key={category.id} className="timeline-focus-filter-option">
                        <span className="timeline-event-checkbox">
                          <input type="checkbox" value={category.id} checked={value.categoryIds.has(category.id)}
                            onChange={event => toggle(category.id, event.currentTarget.checked)} />
                          <Icon name="check" size="small" />
                        </span>
                        <span>{category.label}</span>
                      </label>)}
                    </div>
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>}
            </Popover.Root>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </div>;
});
