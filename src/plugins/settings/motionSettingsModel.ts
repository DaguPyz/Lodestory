import type {ConfigService} from "@lodestory/sdk/config";
import {uiMotionConfig} from "@lodestory/sdk/ui";

type MotionValue = "system" | "reduce";
type MotionSnapshot = Readonly<{pending: boolean; failedValue: MotionValue | null}>;

/** Retain save failures across settings sections and dialog closes. */
export function createMotionSettingsModel(config: ConfigService) {
  let active = true;
  let accepting = true;
  let requestId = 0;
  let stopping: Promise<void> | undefined;
  let snapshot: MotionSnapshot = Object.freeze({pending: false, failedValue: null});
  const listeners = new Set<() => void>();
  const writes = new Set<Promise<void>>();
  function publish(next: MotionSnapshot) {
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { console.error("Motion settings subscriber failed.", {error}); }
    }
  }
  function save(value: MotionValue) {
    if (!accepting) return;
    const current = ++requestId;
    publish({pending: true, failedValue: null});
    const write = Promise.resolve().then(() => config.set(uiMotionConfig, value)).then(() => {
      if (active && requestId === current) publish({pending: false, failedValue: null});
    }).catch(() => {
      if (active && requestId === current) publish({pending: false, failedValue: value});
    });
    writes.add(write);
    void write.then(() => writes.delete(write));
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save,
    retry() { if (snapshot.failedValue !== null) save(snapshot.failedValue); },
    dispose(): Promise<void> {
      if (stopping) return stopping;
      accepting = false;
      stopping = Promise.all([...writes]).then(() => { active = false; listeners.clear(); });
      return stopping;
    },
  };
}

export type MotionSettingsModel = ReturnType<typeof createMotionSettingsModel>;
