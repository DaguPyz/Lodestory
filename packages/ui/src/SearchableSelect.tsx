import { Combobox } from "@base-ui/react/combobox";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { useInteractionRef } from "./Interaction.js";
import type { SelectOption, SelectProps } from "./Select.js";

export type SearchableSelectOption = Omit<SelectOption, "swatch"> & Readonly<{searchText?: string}>;

export type SearchableSelectProps = Pick<SelectProps, "value" | "onValueChange" | "disabled" | "placeholder" |
  "aria-label" | "aria-labelledby"> & {
  options: readonly SearchableSelectOption[];
  /** Accessible name and placeholder for the search input inside the popup. */
  searchLabel: string;
};

/** Single selection with a temporary search query inside the popup. */
export function SearchableSelect({ value, onValueChange, options, searchLabel, disabled = false,
  placeholder = "请选择", "aria-label": label, "aria-labelledby": labelledBy }: SearchableSelectProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const valueId = useId();
  const [open, setOpen] = useState(false);
  const [density, setDensity] = useState<string>();
  const interactionRef = useInteractionRef<HTMLDivElement>(open && !disabled, "select");
  const { contains } = Combobox.useFilter();
  const selected = options.find(option => option.value === value) ?? null;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return <span className="ui-select" data-variant="field">
    <Combobox.Root items={options} value={selected} disabled={disabled} open={open && !disabled} autoHighlight
      filter={(option, query) => contains(option.label, query) || Boolean(option.searchText && contains(option.searchText, query))}
      onOpenChange={nextOpen => {
        if (nextOpen && disabled) return;
        if (nextOpen) setDensity(trigger.current?.closest("[data-ui-density]")?.getAttribute("data-ui-density") ?? undefined);
        setOpen(nextOpen);
      }}
      onValueChange={next => {
        if (next && next.value !== value && !next.disabled && !disabled) onValueChange(next.value);
      }}>
      <Combobox.Trigger ref={trigger} className="ui-select-trigger" type="button" data-variant="field"
        data-ui-placeholder={selected === null || undefined} title={selected?.label}
        aria-label={label} aria-labelledby={labelledBy} aria-describedby={label || labelledBy ? valueId : undefined}>
        <span id={valueId} className="ui-select-value">{selected?.label ?? placeholder}</span>
        <Combobox.Icon className="ui-select-chevron"><Icon name="chevronDown" size="small" /></Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner className="ui-select-positioner" data-ui-density={density} side="bottom" align="start"
          sideOffset={4} collisionPadding={8}>
          <Combobox.Popup ref={interactionRef} className="ui-select-popup ui-select-popup--searchable" aria-label={searchLabel}>
            <div className="ui-select-search">
              <div className="search-field">
                <Icon name="search" size="small" />
                <Combobox.Input aria-label={searchLabel} placeholder={searchLabel} autoComplete="off" spellCheck={false} />
              </div>
            </div>
            <Combobox.Empty className="ui-select-empty ui-select-search-empty">
              {options.length ? "没有匹配的选项" : "暂无选项"}
            </Combobox.Empty>
            <Combobox.List className="ui-select-list" aria-label={searchLabel}>
              {(option: SearchableSelectOption) => <Combobox.Item key={option.value} value={option} disabled={option.disabled}
                className="ui-select-option">
                <span className="ui-select-option-text">{option.label}</span>
              </Combobox.Item>}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  </span>;
}
