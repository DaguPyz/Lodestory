/** Run one cancellable text projection in an isolated worker. */
export function runTextWorker(create: () => Worker, content: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error("正文搜索已取消。"));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = create(); } catch (error) { reject(error); return; }
    let done = false;
    const finish = (error?: Error, text?: string) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error); else resolve(text ?? "");
    };
    const abort = () => finish(new Error("正文搜索已取消。"));
    signal?.addEventListener("abort", abort, {once: true});
    worker.onmessage = event => {
      const result = event.data as {text?: unknown; error?: unknown};
      if (typeof result?.text === "string") finish(undefined, result.text);
      else finish(new Error(typeof result?.error === "string" ? result.error : "无法提取正文。"));
    };
    worker.onerror = () => finish(new Error("无法提取正文。"));
    try { worker.postMessage(content); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    if (signal?.aborted) abort();
  });
}
