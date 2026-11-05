import {useState, type FormEvent, type RefObject} from "react";
import {Button, DialogActions, Icon, IconButton, Select, Textarea, TextField, type SelectOption} from "@lodestory/ui";
import type {AssetFieldOption, AssetSchemaStore, AssetTypeTemplate, AssetValueType} from "./assetSchemaStore";
import {AssetColorPicker} from "./AssetColorPicker";
import {isAssetColor} from "./assetCardColor";

export type AssetSchemaDraft =
  | {kind: "newType" | "editType"; id: string; name: string; description: string; color: string | null}
  | {kind: "newField" | "renameField"; id: string; ownerKind?: "type" | "asset"; typeId: string; title: string; valueType: AssetValueType; options: AssetFieldOption[]; targetTypeId: string | null; defaultText: string; defaultOptions: string[]};

export type AssetSchemaFormProps = {
  draft: AssetSchemaDraft;
  types: readonly AssetTypeTemplate[];
  busy: boolean;
  error: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (draft: AssetSchemaDraft) => void;
  onCancel: () => void;
  onSubmit: (operation: () => Promise<boolean>) => void;
  store: AssetSchemaStore;
};

const VALUE_TYPE_OPTIONS: readonly SelectOption[] = [
  {value: "text", label: "文字"},
  {value: "number", label: "数字"},
  {value: "singleSelect", label: "单选"},
  {value: "multiSelect", label: "多选"},
  {value: "reference", label: "关联对象"},
];

function characterCount(value: string): number {
  return Array.from(value).length;
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function makeOption(): AssetFieldOption {
  return {id: globalThis.crypto.randomUUID(), title: ""};
}

function isTypeDraft(draft: AssetSchemaDraft): draft is Extract<AssetSchemaDraft, {kind: "newType" | "editType"}> {
  return draft.kind === "newType" || draft.kind === "editType";
}

function isSelectValueType(valueType: AssetValueType): boolean {
  return valueType === "singleSelect" || valueType === "multiSelect";
}

export function AssetSchemaForm({draft, types, busy, error, inputRef, onChange, onCancel, onSubmit, store}: AssetSchemaFormProps) {
  const [validationError, setValidationError] = useState<string | null>(null);
  const hasPendingSave = store.getSnapshot().dirty;
  const fieldsDisabled = busy || hasPendingSave;
  const isAssetField = !isTypeDraft(draft) && draft.ownerKind === "asset";
  const valueLabel = isAssetField ? "字段值" : "默认值";
  const emptyValueLabel = isAssetField ? "不填写字段值" : "不设置默认值";

  function validateType(): string | null {
    if (!isTypeDraft(draft)) return null;
    const name = draft.name.trim();
    const nameLength = characterCount(name);
    if (nameLength < 1 || nameLength > 60) return "模板名称需要填写 1–60 个字符。";
    if (characterCount(draft.description) > 200) return "模板说明不能超过 200 个字符。";
    if (draft.color !== null && !isAssetColor(draft.color)) return "颜色需要使用 #RRGGBB 格式。";
    if (types.some(type => type.id !== draft.id && type.status === "active" && normalizedName(type.name) === normalizedName(name))) {
      return "已存在同名的资产模板。";
    }
    return null;
  }

  function validateField(): string | null {
    if (isTypeDraft(draft)) return null;
    const title = draft.title.trim();
    const titleLength = characterCount(title);
    if (titleLength < 1 || titleLength > 60) return "字段名称需要填写 1–60 个字符。";
    const ownerKind = draft.ownerKind ?? "type";
    if (ownerKind === "type") {
      const type = types.find(item => item.id === draft.typeId);
      if (!type || type.status !== "active") return "请选择一个可用的资产模板。";
    } else if (!store.getSnapshot().assets.some(asset => asset.id === draft.typeId)) {
      return "所属对象不存在，请重新选择。";
    }

    const existingTitle = store.getSnapshot().fields.some(field => field.owner.kind === ownerKind && field.owner.id === draft.typeId
      && field.id !== (draft.kind === "renameField" ? draft.id : "")
      && field.status === "active"
      && normalizedName(field.title) === normalizedName(title));
    if (existingTitle) return ownerKind === "asset" ? "该对象中已存在同名字段。" : "该模板中已存在同名字段。";

    if (draft.kind === "renameField") return null;

    if (isSelectValueType(draft.valueType)) {
      if (draft.options.length < 1 || draft.options.length > 100) return "单选和多选字段需要 1–100 个选项。";
      const optionTitles = new Set<string>();
      for (const option of draft.options) {
        const optionTitle = option.title.trim();
        const optionLength = characterCount(optionTitle);
        if (optionLength < 1 || optionLength > 60) return "每个选项标题需要填写 1–60 个字符。";
        const key = normalizedName(optionTitle);
        if (optionTitles.has(key)) return "同一字段中的选项标题不能重复。";
        optionTitles.add(key);
      }
      if (draft.defaultOptions.some(id => !draft.options.some(option => option.id === id))) {
        return isAssetField ? "字段值必须来自当前字段的选项。" : "默认选项必须来自当前字段的选项。";
      }
      if (draft.valueType === "singleSelect" && draft.defaultOptions.length > 1) return isAssetField ? "单选字段只能选择一个值。" : "单选字段只能设置一个默认选项。";
    } else if (draft.valueType === "number" && draft.defaultText.trim() !== "") {
      const numericDefault = Number(draft.defaultText);
      if (!Number.isFinite(numericDefault)) return isAssetField ? "字段值必须是有效数字。" : "数字默认值必须是有效数字。";
    }

    if (draft.valueType === "reference" && draft.targetTypeId !== null
      && !types.some(type => type.id === draft.targetTypeId && type.status === "active")) {
      return "关联资产模板无效，请重新选择。";
    }
    return null;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (hasPendingSave) {
      onSubmit(() => store.retry());
      return;
    }
    if (!event.currentTarget.reportValidity()) return;

    const message = isTypeDraft(draft) ? validateType() : validateField();
    if (message) {
      setValidationError(message);
      return;
    }
    setValidationError(null);

    if (draft.kind === "newType") {
      const input = {id: draft.id, name: draft.name.trim(), description: draft.description, color: draft.color};
      onSubmit(() => store.createType(input));
    } else if (draft.kind === "editType") {
      const id = draft.id;
      const patch = {name: draft.name.trim(), description: draft.description, color: draft.color};
      onSubmit(() => store.updateType(id, patch));
    } else if (draft.kind === "renameField") {
      const id = draft.id;
      const title = draft.title.trim();
      onSubmit(() => store.renameField(id, title));
    } else if (draft.kind === "newField") {
      const {id, typeId, title, valueType} = draft;
      const options = isSelectValueType(valueType)
        ? draft.options.map(option => ({id: option.id, title: option.title.trim()}))
        : undefined;
      const config = valueType === "reference"
        ? {targetTypeId: draft.targetTypeId}
        : options !== undefined ? {options} : {};
      let defaultValue: string | number | readonly string[] | undefined;
      if (valueType === "text" && draft.defaultText !== "") defaultValue = draft.defaultText;
      else if (valueType === "number" && draft.defaultText.trim() !== "") defaultValue = Number(draft.defaultText);
      else if (valueType === "singleSelect" && draft.defaultOptions[0]) defaultValue = draft.defaultOptions[0];
      else if (valueType === "multiSelect" && draft.defaultOptions.length > 0) defaultValue = [...draft.defaultOptions];

      const input = {
        id,
        owner: {kind: draft.ownerKind ?? "type", id: typeId},
        title: title.trim(),
        valueType,
        config,
        ...(defaultValue !== undefined ? {defaultValue} : {}),
      };
      onSubmit(() => store.createField(input));
    }
  }

  function updateOption(optionId: string, title: string) {
    if (draft.kind !== "newField") return;
    onChange({...draft, options: draft.options.map(option => option.id === optionId ? {...option, title} : option)});
    setValidationError(null);
  }

  function setDefaultOption(optionId: string, checked: boolean) {
    if (draft.kind !== "newField") return;
    const defaultOptions = draft.valueType === "singleSelect"
      ? checked ? [optionId] : []
      : checked ? [...draft.defaultOptions.filter(id => id !== optionId), optionId] : draft.defaultOptions.filter(id => id !== optionId);
    onChange({...draft, defaultOptions});
  }

  function updateOptionList(nextOptions: AssetFieldOption[]) {
    if (draft.kind !== "newField") return;
    const validIds = new Set(nextOptions.map(option => option.id));
    onChange({...draft, options: nextOptions, defaultOptions: draft.defaultOptions.filter(id => validIds.has(id))});
    setValidationError(null);
  }

  const displayedError = validationError ?? error;
  const submitLabel = busy ? "保存中…"
    : hasPendingSave || error?.includes("保存") ? "重试保存"
      : draft.kind === "newType" ? "创建模板"
        : draft.kind === "newField" ? "添加字段" : "保存";

  return <form className="asset-schema-form" onSubmit={handleSubmit} aria-busy={busy || undefined} noValidate>
    {isTypeDraft(draft) ? <>
      <label className="asset-form-field">
        <span>模板名称</span>
        <TextField ref={inputRef} autoFocus={false} value={draft.name} disabled={fieldsDisabled} autoComplete="off"
          placeholder="例如：人物、兵器、功法"
          aria-label="模板名称" aria-describedby="asset-type-name-help"
          onChange={event => {onChange({...draft, name: event.currentTarget.value}); setValidationError(null);}} />
        <span className="asset-form-help" id="asset-type-name-help">{characterCount(draft.name.trim())}/60</span>
      </label>
      <label className="asset-form-field">
        <span>模板说明</span>
        <Textarea value={draft.description} disabled={fieldsDisabled} aria-label="模板说明"
          onChange={event => {onChange({...draft, description: event.currentTarget.value}); setValidationError(null);}} />
        <span className="asset-form-help">{characterCount(draft.description)}/200</span>
      </label>
      <AssetColorPicker value={draft.color} disabled={fieldsDisabled} target="左侧列表选项"
        onChange={color => {onChange({...draft, color}); setValidationError(null);}}/>
    </> : <>
      <label className="asset-form-field">
        <span>字段名称</span>
        <TextField ref={inputRef} value={draft.title} disabled={fieldsDisabled} autoComplete="off"
          placeholder="例如：别名、品阶、材质"
          aria-label="字段名称" aria-describedby="asset-field-title-help"
          onChange={event => {onChange({...draft, title: event.currentTarget.value}); setValidationError(null);}} />
        <span className="asset-form-help" id="asset-field-title-help">{characterCount(draft.title.trim())}/60</span>
      </label>

      {draft.kind === "newField" && <>
        <label className="asset-form-field">
          <span>字段类型</span>
          <Select value={draft.valueType} options={VALUE_TYPE_OPTIONS} disabled={fieldsDisabled} aria-label="字段类型"
            onValueChange={value => {
              const valueType = value as AssetValueType;
              const options = isSelectValueType(valueType) && draft.options.length === 0 ? [makeOption()] : draft.options;
              onChange({...draft, valueType, options, defaultText: "", defaultOptions: []});
              setValidationError(null);
            }} />
        </label>

        {isSelectValueType(draft.valueType) && <div className="asset-option-fields">
          <div className="asset-form-field">
            <span>选项</span>
            <div className="asset-option-list">
              {draft.options.map((option, index) => <div className="asset-option-row" key={option.id}>
                <TextField value={option.title} disabled={fieldsDisabled} autoComplete="off" aria-label={`选项 ${index + 1}`}
                  onChange={event => updateOption(option.id, event.currentTarget.value)} />
                <IconButton label={`删除选项 ${index + 1}`} disabled={fieldsDisabled || draft.options.length <= 1}
                  onClick={() => updateOptionList(draft.options.filter(item => item.id !== option.id))}>
                  <Icon name="close" size="small" />
                </IconButton>
              </div>)}
            </div>
            <Button variant="ghost" type="button" disabled={fieldsDisabled || draft.options.length >= 100}
              onClick={() => updateOptionList([...draft.options, makeOption()])}>
              <Icon name="plus" size="small" /> 添加选项
            </Button>
            <span className="asset-form-help">可添加 1–100 个选项</span>
          </div>

          <div className="asset-form-field">
            <span>{valueLabel} <span className="asset-optional">选填</span></span>
            {draft.valueType === "singleSelect" ? <Select value={draft.defaultOptions[0] ?? ""}
              options={[{value: "", label: emptyValueLabel}, ...draft.options.map((option, index) => ({value: option.id, label: option.title.trim() || `选项 ${index + 1}`}))]}
              disabled={fieldsDisabled} placeholder={emptyValueLabel} aria-label={isAssetField ? "字段值" : "默认选项"}
              onValueChange={value => {onChange({...draft, defaultOptions: value === "" ? [] : [value]}); setValidationError(null);}} />
              : <div className="asset-default-options">
                {draft.options.map((option, index) => <label className="asset-default-check" key={option.id}>
                  <span className="asset-checkbox-control">
                    <input className="asset-checkbox-input" type="checkbox" checked={draft.defaultOptions.includes(option.id)} disabled={fieldsDisabled}
                      onChange={event => {setDefaultOption(option.id, event.currentTarget.checked); setValidationError(null);}} />
                    <Icon name="check" size="small" />
                  </span>
                  <span>{option.title.trim() || `选项 ${index + 1}`}</span>
                </label>)}
              </div>}
          </div>
        </div>}

        {draft.valueType === "reference" && <label className="asset-form-field">
          <span>关联资产模板</span>
          <Select value={draft.targetTypeId ?? ""} disabled={fieldsDisabled} aria-label="关联资产模板" placeholder="任意对象"
            options={[{value: "", label: "任意对象"}, ...types.filter(type => type.status === "active").map(type => ({value: type.id, label: type.name}))]}
            onValueChange={value => {onChange({...draft, targetTypeId: value === "" ? null : value}); setValidationError(null);}} />
          <span className="asset-form-help">不指定模板时，可关联任意对象。</span>
        </label>}

        {(draft.valueType === "text" || draft.valueType === "number") && <label className="asset-form-field">
          <span>{valueLabel} <span className="asset-optional">选填</span></span>
          {draft.valueType === "number" ? <TextField type="number" defaultValue={draft.defaultText} disabled={fieldsDisabled}
            step="any" aria-label={valueLabel}
            onInput={event => {
              const input = event.currentTarget;
              if (input.validity.badInput) {
                input.setCustomValidity("请输入有效数字。");
                return;
              }
              input.setCustomValidity("");
              onChange({...draft, defaultText: input.value === "" ? "" : input.value});
              setValidationError(null);
            }} /> : <TextField type="text" value={draft.defaultText} disabled={fieldsDisabled} aria-label={valueLabel}
            onChange={event => {onChange({...draft, defaultText: event.currentTarget.value}); setValidationError(null);}} />}
        </label>}
      </>}
    </>}

    {displayedError && <p className="asset-form-error" role="alert">{displayedError}</p>}

    <DialogActions>
      <Button variant="secondary" type="button" disabled={busy} onClick={onCancel}>{hasPendingSave ? "关闭" : "取消"}</Button>
      <Button type="submit" variant="primary" disabled={busy}>{submitLabel}</Button>
    </DialogActions>
  </form>;
}
