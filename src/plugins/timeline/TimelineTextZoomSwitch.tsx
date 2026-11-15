import {Button} from "@lodestory/ui";

export function TimelineTextZoomSwitch({checked, disabled, onChange}: {
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return <span className="timeline-text-zoom-switch">
    <Button variant="ghost" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="timeline-text-zoom-track" aria-hidden="true" />文字随缩放
    </Button>
  </span>;
}
