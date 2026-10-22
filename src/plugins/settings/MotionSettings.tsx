import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { ConfigService } from "@lodestory/sdk/config";
import { uiMotionConfig } from "@lodestory/sdk/ui";
import { Button, Select } from "@lodestory/ui";
import "./motion-settings.css";

const motionOptions = [
  { value: "system", label: "跟随系统" },
  { value: "reduce", label: "减少动效" },
] as const;

export function MotionSettings({ config }: { config: ConfigService }) {
  const subscribe = useCallback((listener: () => void) => config.subscribe(uiMotionConfig, listener), [config]);
  const getSnapshot = useCallback(() => config.getSnapshot(uiMotionConfig), [config]);
  const preference = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const requestId = useRef(0);
  const [retryValue, setRetryValue] = useState<"system" | "reduce" | null>(null);
  const [saveError, setSaveError] = useState(false);

  const save = useCallback((value: "system" | "reduce") => {
    const currentRequest = ++requestId.current;
    setRetryValue(value);
    setSaveError(false);
    void config.set(uiMotionConfig, value).then(() => {
      if (requestId.current !== currentRequest) return;
      setRetryValue(null);
      setSaveError(false);
    }).catch(() => {
      if (requestId.current !== currentRequest) return;
      // ConfigService publishes only after persistence succeeds, so the selected
      // value above continues to reflect the last valid saved preference.
      setSaveError(true);
    });
  }, [config]);

  return (
    <section className="motion-settings" aria-labelledby="motion-settings-heading">
      <h3 id="motion-settings-heading">动效</h3>
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
            if (value === "system" || value === "reduce") save(value);
          }}
        />
      </div>
      {saveError && retryValue !== null && (
        <div className="motion-settings-error" role="alert">
          <p>动效设置未能保存，当前设置仍保持不变。</p>
          <Button variant="ghost" onClick={() => save(retryValue)}>重试</Button>
        </div>
      )}
    </section>
  );
}
