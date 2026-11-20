import type {Translate} from "@lodestory/sdk/i18n";
import {useId} from "react";
import {TextField} from "@lodestory/ui";
import {ASSET_COLOR_PRESETS, assetCardColorStyle, isAssetColor} from "./assetCardColor";

export function AssetColorPicker({t, value, disabled, onChange, target = t("卡片")}: {
  t: Translate;
  value: string | null;
  disabled: boolean;
  onChange(value: string | null): void;
  target?: string;
}) {
  const id = useId();
  return <fieldset className="asset-color-picker" disabled={disabled} aria-describedby={`${id}-hint`}>
    <legend>{t("颜色标记")}<span className="asset-optional">{t("选填")}</span></legend>
    <div className="asset-color-presets">
      <label className="asset-color-choice asset-color-default" title={t("使用默认{target}背景", {values: {target}})}>
        <input type="radio" name={`${id}-preset`} value="default" aria-label={t("默认")} checked={value === null}
          onChange={() => onChange(null)}/>
        <span>{t("默认")}</span>
      </label>
      {ASSET_COLOR_PRESETS.map(preset => <label key={preset.value} className="asset-color-choice" title={`${t(preset.name)} · ${preset.value.toUpperCase()}`}>
        <input type="radio" name={`${id}-preset`} value={preset.value} aria-label={t(preset.name)}
          checked={value?.toLowerCase() === preset.value} onChange={() => onChange(preset.value)}/>
        <span style={assetCardColorStyle(preset.value)} />
      </label>)}
    </div>
    <div className="asset-color-custom">
      <label><span>{t("自定义")}</span><input className="asset-color-native" type="color" aria-label={t("自定义颜色")}
        value={isAssetColor(value) ? value : "#d8e5f2"} onChange={event => onChange(event.currentTarget.value)}/></label>
      <TextField aria-label={t("颜色值")} aria-describedby={`${id}-hint`} autoComplete="off" spellCheck={false}
        value={value ?? ""} placeholder="#RRGGBB" pattern="#[0-9a-fA-F]{6}" maxLength={7}
        title={t("请输入完整的颜色值，例如 #D8E5F2")} onChange={event => onChange(event.currentTarget.value || null)}/>
    </div>
    <p id={`${id}-hint`} className="asset-form-help">{t("用于{target}背景，可选候选色或输入十六进制颜色；选择“默认”可清除。", {values: {target}})}</p>
  </fieldset>;
}
