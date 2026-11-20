import type {Translate} from "@lodestory/sdk/i18n";
import {useLayoutEffect, useRef, useState} from "react";
import {Icon, Select, Textarea, TextField, type SelectOption} from "@lodestory/ui";
import type {AssetFieldDefinition, AssetPropertyValue, AssetRecord} from "./assetSchemaStore";

export type AssetValueFieldsProps = {
  t: Translate;
  fields: readonly AssetFieldDefinition[];
  assets: readonly AssetRecord[];
  values: Readonly<Record<string, AssetPropertyValue>>;
  disabled: boolean;
  onChange: (fieldId: string, value: AssetPropertyValue) => void;
};

const VALUE_TYPE_LABELS = {
  text: "文字",
  number: "数字",
  singleSelect: "单选",
  multiSelect: "多选",
  reference: "关联对象",
} satisfies Record<AssetFieldDefinition["valueType"], string>;

function numberValue(value: AssetPropertyValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: AssetPropertyValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function stringListValue(value: AssetPropertyValue | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function AssetValueFields({t, fields, assets, values, disabled, onChange}: AssetValueFieldsProps) {
  const numberInputs = useRef(new Map<string, HTMLInputElement>());
  const previousValues = useRef(values);
  const reportedValues = useRef(new Map<string, AssetPropertyValue>());
  const [numberErrors, setNumberErrors] = useState<Readonly<Record<string, string>>>({});

  useLayoutEffect(() => {
    if (previousValues.current === values) return;

    const errors = {...numberErrors};
    for (const field of fields) {
      if (field.valueType !== "number") continue;
      const before = previousValues.current[field.id] ?? null;
      const next = values[field.id] ?? null;
      const wasReported = reportedValues.current.has(field.id);
      const matchesReported = wasReported && Object.is(reportedValues.current.get(field.id), next);
      const input = numberInputs.current.get(field.id);

      if (!matchesReported && !Object.is(before, next)) {
        if (input) {
          input.value = numberValue(next) === null ? "" : String(next);
          input.setCustomValidity("");
        }
        delete errors[field.id];
      }
    }
    reportedValues.current.clear();
    previousValues.current = values;
    setNumberErrors(errors);
  }, [fields, numberErrors, values]);

  const orderedFields = fields.filter(field => field.status === "active").slice().sort((a, b) => a.order - b.order);

  function updateNumber(fieldId: string, input: HTMLInputElement) {
    if (input.validity.badInput) {
      const message = t("请输入有效数字。");
      input.setCustomValidity(message);
      setNumberErrors(current => current[fieldId] === message ? current : {...current, [fieldId]: message});
      return;
    }

    input.setCustomValidity("");
    setNumberErrors(current => {
      if (!(fieldId in current)) return current;
      const next = {...current};
      delete next[fieldId];
      return next;
    });

    const nextValue = input.value === "" ? null : input.valueAsNumber;
    if (nextValue !== null && !Number.isFinite(nextValue)) {
      const message = t("请输入有效数字。");
      input.setCustomValidity(message);
      setNumberErrors(current => ({...current, [fieldId]: message}));
      return;
    }

    reportedValues.current.set(fieldId, nextValue);
    onChange(fieldId, nextValue);
  }

  return <div className="asset-value-fields">
    {orderedFields.map(field => {
      const value = values[field.id];
      const typeLabel = VALUE_TYPE_LABELS[field.valueType];

      if (field.valueType === "text") {
        return <label className="asset-form-field" key={field.id}>
          <span>{field.title}<span className="asset-optional"> · {typeLabel}</span></span>
          <Textarea id={`asset-value-${field.id}`} value={stringValue(value) ?? ""} disabled={disabled}
            aria-label={field.title}
            onChange={event => onChange(field.id, event.currentTarget.value)} />
        </label>;
      }

      if (field.valueType === "number") {
        const errorId = `asset-value-error-${field.id}`;
        const currentNumber = numberValue(value);
        return <label className="asset-form-field" key={field.id}>
          <span>{field.title}<span className="asset-optional"> · {typeLabel}</span></span>
          <TextField id={`asset-value-${field.id}`} type="number" step="any" defaultValue={currentNumber === null ? "" : String(currentNumber)}
            disabled={disabled} aria-label={field.title} aria-invalid={numberErrors[field.id] ? true : undefined}
            aria-describedby={numberErrors[field.id] ? errorId : undefined}
            ref={element => {
              if (element) numberInputs.current.set(field.id, element);
              else numberInputs.current.delete(field.id);
            }}
            onInput={event => updateNumber(field.id, event.currentTarget)} />
          {numberErrors[field.id] && <span className="asset-form-error" id={errorId}>{numberErrors[field.id]}</span>}
        </label>;
      }

      if (field.valueType === "singleSelect") {
        const current = stringValue(value);
        const options: SelectOption[] = [{value: "", label: t("未设置")}, ...(field.config.options ?? []).map(option => ({value: option.id, label: option.title}))];
        if (current && !options.some(option => option.value === current)) {
          options.push({value: current, label: t("已移除选项（{current}）", {values: {current}}), disabled: true});
        }
        return <label className="asset-form-field" key={field.id}>
          <span>{field.title}<span className="asset-optional"> · {typeLabel}</span></span>
          <Select id={`asset-value-${field.id}`} value={current ?? ""} options={options} disabled={disabled}
            aria-label={field.title} placeholder={t("未设置")}
            onValueChange={next => onChange(field.id, next === "" ? null : next)} />
        </label>;
      }

      if (field.valueType === "multiSelect") {
        const selected = stringListValue(value);
        const options = [...(field.config.options ?? [])];
        for (const selectedId of selected) {
          if (!options.some(option => option.id === selectedId)) options.push({id: selectedId, title: t("已移除选项（{selectedId}）", {values: {selectedId}})});
        }
        return <fieldset className="asset-option-fields" key={field.id}>
          <legend>{field.title}<span className="asset-optional"> · {typeLabel}</span></legend>
          <div className="asset-default-options">
            {options.map(option => <label className="asset-default-check" key={option.id}>
              <span className="asset-checkbox-control">
                <input className="asset-checkbox-input" type="checkbox" checked={selected.includes(option.id)} disabled={disabled}
                  aria-label={`${field.title}：${option.title}`}
                  onChange={event => {
                    const next = event.currentTarget.checked
                      ? [...selected, option.id]
                      : selected.filter(id => id !== option.id);
                    onChange(field.id, next);
                  }} />
                <Icon name="check" size="small" />
              </span>
              <span>{option.title}</span>
            </label>)}
          </div>
        </fieldset>;
      }

      const current = stringValue(value);
      const targetTypeId = field.config.targetTypeId ?? null;
      const matchingAssets = assets.filter(asset => targetTypeId === null || asset.typeId === targetTypeId);
      const options: SelectOption[] = [{value: "", label: t("无关联")}, ...matchingAssets.map(asset => ({value: asset.id, label: asset.name}))];
      if (current && !options.some(option => option.value === current)) {
        const existing = assets.find(asset => asset.id === current);
        options.push({value: current, label: existing
          ? t("不符合目标类型：{name}", {values: {name: existing.name}})
          : t("资产已不存在（{current}）", {values: {current}}), disabled: true});
      }
      return <label className="asset-form-field" key={field.id}>
        <span>{field.title}<span className="asset-optional"> · {typeLabel}</span></span>
        <Select id={`asset-value-${field.id}`} value={current ?? ""} options={options} disabled={disabled}
          aria-label={field.title} placeholder={t("无关联")}
          onValueChange={next => onChange(field.id, next === "" ? null : next)} />
      </label>;
    })}
  </div>;
}
