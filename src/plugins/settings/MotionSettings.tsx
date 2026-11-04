import { useCallback, useSyncExternalStore } from "react";
import type { ConfigService } from "@lodestory/sdk/config";
import { uiMotionConfig } from "@lodestory/sdk/ui";
import { Button, Select } from "@lodestory/ui";
import type { MotionSettingsModel } from "./motionSettingsModel";
import "./motion-settings.css";

const motionOptions = [
  { value: "system", label: "跟随系统" },
  { value: "reduce", label: "减少动效" },
] as const;

export function MotionSettings({ config, model }: { config: ConfigService; model: MotionSettingsModel }) {
  const subscribe = useCallback((listener: () => void) => config.subscribe(uiMotionConfig, listener), [config]);
  const getSnapshot = useCallback(() => config.getSnapshot(uiMotionConfig), [config]);
  const preference = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const {pending, failedValue} = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);

  return (
    <section className="motion-settings" aria-label="动效设置">
      <p className="motion-settings-description" id="motion-settings-description">
        跟随系统设置，或始终减少界面动效；设备要求减少动效时始终生效。
      </p>
      <div className="motion-settings-control">
        <span id="motion-preference-label">动效偏好</span>
        <Select
          aria-labelledby="motion-preference-label"
          aria-describedby="motion-settings-description"
          value={preference}
          options={motionOptions}
          onValueChange={value => {
            if (value === "system" || value === "reduce") model.save(value);
          }}
        />
      </div>
      {pending && <p className="motion-settings-status" role="status">正在保存…</p>}
      {failedValue !== null && (
        <div className="motion-settings-error" role="alert">
          <p>动效设置未能保存，当前设置仍保持不变。</p>
          <Button variant="ghost" onClick={model.retry}>重试</Button>
        </div>
      )}
    </section>
  );
}
