const MAX_UNITS_PER_TASK = 64 * 1024;
const UNITS_PER_CLOCK_CHECK = 1024;
const MAX_TASK_MILLISECONDS = 3;

/**
 * Count Unicode code points after removing JavaScript whitespace, yielding between chunks.
 * The caller owns cancellation and must not treat an incomplete task as a current count.
 */
export function startChunkedCharacterCount(
  text: string,
  onComplete: (count: number) => void,
  onError: (error: unknown) => void = () => {},
): () => void {
  let index = 0;
  let count = 0;
  let pendingHighSurrogate = false;
  let cancelled = false;
  let finished = false;
  let channel: MessageChannel | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  function closeChannel() {
    const current = channel;
    channel = undefined;
    if (!current) return;
    try { current.port1.onmessage = null; current.port1.close(); } catch { /* Already closed. */ }
    try { current.port2.close(); } catch { /* Already closed. */ }
  }

  function cleanup() {
    closeChannel();
    if (fallbackTimer !== undefined) {
      clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
    }
  }

  function reportError(error: unknown) {
    if (cancelled || finished) return;
    finished = true;
    cleanup();
    try { onError(error); } catch { /* Reporting must not retain task resources. */ }
  }

  function countCodeUnit(code: number) {
    if (isWhitespace(code)) return;

    if (pendingHighSurrogate) {
      if (code >= 0xdc00 && code <= 0xdfff) {
        count++;
        pendingHighSurrogate = false;
        return;
      }
      count++;
    }

    pendingHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    if (!pendingHighSurrogate) count++;
  }

  function runChunk() {
    if (cancelled || finished) return;
    fallbackTimer = undefined;
    try {
      const started = performance.now();
      const taskEnd = Math.min(text.length, index + MAX_UNITS_PER_TASK);
      while (index < taskEnd) {
        const batchEnd = Math.min(taskEnd, index + UNITS_PER_CLOCK_CHECK);
        while (index < batchEnd) countCodeUnit(text.charCodeAt(index++));
        if (performance.now() - started >= MAX_TASK_MILLISECONDS) break;
      }

      if (index < text.length) {
        schedule();
        return;
      }

      if (pendingHighSurrogate) count++;
      finished = true;
      cleanup();
      try { onComplete(count); }
      catch (error) {
        try { onError(error); } catch { /* Reporting must not retain task resources. */ }
      }
    } catch (error) {
      reportError(error);
    }
  }

  function schedule() {
    if (cancelled || finished) return;
    const Channel = globalThis.MessageChannel;
    if (typeof Channel === "function") {
      try {
        if (!channel) {
          channel = new Channel();
          channel.port1.onmessage = runChunk;
        }
        channel.port2.postMessage(0);
        return;
      } catch {
        closeChannel();
      }
    }

    try { fallbackTimer = setTimeout(runChunk, 0); }
    catch (error) { reportError(error); }
  }

  // Even the first chunk is a task, so mounting a large document never scans in render.
  schedule();
  return () => {
    if (cancelled || finished) return;
    cancelled = true;
    cleanup();
  };
}

function isWhitespace(code: number): boolean {
  return code >= 0x0009 && code <= 0x000d
    || code === 0x0020 || code === 0x00a0 || code === 0x1680
    || code >= 0x2000 && code <= 0x200a
    || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0x3000 || code === 0xfeff;
}
