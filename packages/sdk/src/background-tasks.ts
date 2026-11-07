import {createServiceKey} from "./ServiceKey.js";

/** A task consumes JSON-compatible input and returns bytes. */
export type BackgroundTaskFallback = (input: unknown) => Uint8Array | Promise<Uint8Array>;
export type BackgroundTasks = {
  registerFallback(name: string, task: BackgroundTaskFallback): () => void;
  execute(name: string, input: unknown): Promise<Uint8Array>;
};

export const backgroundTasksKey = createServiceKey<BackgroundTasks>("app/background-tasks");
