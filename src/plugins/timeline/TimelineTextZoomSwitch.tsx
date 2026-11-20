import type {Translate} from "@lodestory/sdk/i18n";
import {Button} from "@lodestory/ui";

export function TimelineTextZoomSwitch({t, checked, disabled, onChange}: {
  t: Translate;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return <span className="timeline-text-zoom-switch">
    <Button variant="ghost" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="timeline-text-zoom-track" aria-hidden="true" />{t("文字随缩放")}</Button>
  </span>;
}
