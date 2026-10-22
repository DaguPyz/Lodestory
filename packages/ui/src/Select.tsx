import { Select as BaseSelect } from "@base-ui/react/select";
import { useEffect, useImperativeHandle, useRef, useState, type ComponentPropsWithRef, type RefObject } from "react";
import type { FocusSurface } from "./FocusSurface.js";
import { Icon } from "./Icon.js";

export type SelectOption = Readonly<{
  value: string;
  label: string;
  disabled?: boolean;
  /** A content color sample, e.g. a document's text color; never the control's theme. */
  swatch?: string;
}>;

type TriggerProps = Omit<ComponentPropsWithRef<"button">,
  "children" | "className" | "style" | "type" | "value" | "defaultValue" | "onChange" | "onSelect">;

export type SelectProps = TriggerProps & {
  /** null means no selection. An empty string is a valid option value. */
  value: string | null;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  required?: boolean;
  autoComplete?: string;
  focusSurface?: FocusSurface;
  onOpenChange?: (open: boolean) => void;
  finalFocus?: RefObject<HTMLElement | null> | boolean;
};

function Swatch({ color }: { color: string }) {
  return <span className="ui-select-swatch" style={{ backgroundColor: color }} aria-hidden="true" />;
}

/** Single selection: plugins own the value and options; the package owns the popup. */
export function Select({ value, options, onValueChange, placeholder = "请选择", disabled = false, readOnly = false,
  required, name, form, autoComplete, id, ref, focusSurface, onOpenChange, finalFocus, ...triggerProps }: SelectProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [density, setDensity] = useState<string>();
  useImperativeHandle(ref, () => trigger.current!, []);
  const selected = options.find(option => option.value === value);

  // A plugin can become busy while the popup is open. Withdraw that interaction immediately.
  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
      onOpenChange?.(false);
    }
  }, [disabled, open, onOpenChange]);

  return <span className="ui-select">
    <BaseSelect.Root value={value} items={options} name={name} form={form} id={id} autoComplete={autoComplete}
      required={required} disabled={disabled} readOnly={readOnly} open={open && !disabled}
      onOpenChange={(nextOpen) => {
        if (nextOpen && disabled) return;
        if (nextOpen) setDensity(trigger.current?.closest("[data-ui-density]")?.getAttribute("data-ui-density") ?? undefined);
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
      }}
      onValueChange={(nextValue) => {
        if (nextValue !== null && !disabled && !readOnly && options.some(option => option.value === nextValue && !option.disabled)) {
          onValueChange(nextValue);
        }
      }}>
      <BaseSelect.Trigger {...triggerProps} ref={trigger} className="ui-select-trigger" type="button"
        data-focus-surface={focusSurface} data-ui-placeholder={value === null || undefined}>
        {selected?.swatch && <Swatch color={selected.swatch} />}
        <BaseSelect.Value className="ui-select-value">{value === null ? placeholder : selected?.label ?? value}</BaseSelect.Value>
        <BaseSelect.Icon className="ui-select-chevron"><Icon name="chevronDown" size="small" /></BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="ui-select-positioner" data-ui-density={density} side="bottom" align="start"
          sideOffset={4} collisionPadding={8} alignItemWithTrigger={false}>
          <BaseSelect.Popup className="ui-select-popup" finalFocus={finalFocus}>
            <BaseSelect.List className="ui-select-list">
              {options.map(option => <BaseSelect.Item key={option.value} value={option.value} disabled={option.disabled}
                label={option.label} className="ui-select-option">
                <BaseSelect.ItemIndicator className="ui-select-indicator" keepMounted><Icon name="check" size="small" /></BaseSelect.ItemIndicator>
                {option.swatch && <Swatch color={option.swatch} />}
                <BaseSelect.ItemText className="ui-select-option-text">{option.label}</BaseSelect.ItemText>
              </BaseSelect.Item>)}
              {options.length === 0 && <div className="ui-select-empty" role="status">暂无选项</div>}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  </span>;
}
