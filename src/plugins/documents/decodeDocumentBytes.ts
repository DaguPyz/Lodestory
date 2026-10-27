import type {ProjectByteView} from "@lodestory/sdk/project-storage";

const DECODE_CHUNK_BYTES = 64 * 1024;
type DecodeBytes = readonly number[] | ProjectByteView;

function isByteView(bytes: DecodeBytes): bytes is ProjectByteView {
  return !Array.isArray(bytes) && typeof (bytes as ProjectByteView).copyTo === "function";
}

function createTaskScheduler() {
  let channel: MessageChannel | undefined;
  let resolvePending: (() => void) | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  if (typeof MessageChannel !== "undefined") {
    try {
      channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const resolve = resolvePending;
        resolvePending = undefined;
        resolve?.();
      };
    } catch {
      channel = undefined;
    }
  }

  return {
    yieldTask() {
      return new Promise<void>(resolve => {
        resolvePending = resolve;
        if (channel) {
          try {
            channel.port2.postMessage(0);
            return;
          } catch {
            channel.port1.close();
            channel.port2.close();
            channel = undefined;
          }
        }
        fallbackTimer = setTimeout(() => {
          fallbackTimer = undefined;
          const complete = resolvePending;
          resolvePending = undefined;
          complete?.();
        }, 0);
      });
    },
    close() {
      channel?.port1.close();
      channel?.port2.close();
      channel = undefined;
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
      const resolve = resolvePending;
      resolvePending = undefined;
      resolve?.();
    },
  };
}

/** Decode immutable project bytes in task-sized chunks without making a second full-size byte array. */
export async function decodeDocumentBytes(bytes: DecodeBytes, isCurrent: () => boolean = () => true): Promise<string> {
  const decoder = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true});
  const chunks: string[] = [];
  const scheduler = createTaskScheduler();
  const chunk = new Uint8Array(DECODE_CHUNK_BYTES);
  let chunkLength = 0;
  let yieldBeforeNextByte = false;

  try {
    if (!isCurrent()) throw new Error("文档解码已取消。");
    if (isByteView(bytes)) {
      let sourceOffset = 0;
      while (sourceOffset < bytes.byteLength) {
        if (yieldBeforeNextByte) {
          await scheduler.yieldTask();
          if (!isCurrent()) throw new Error("文档解码已取消。");
          yieldBeforeNextByte = false;
        }
        chunkLength = Math.min(chunk.length, bytes.byteLength - sourceOffset);
        bytes.copyTo(chunk, 0, sourceOffset, chunkLength);
        chunks.push(decoder.decode(chunk.subarray(0, chunkLength), {stream: true}));
        sourceOffset += chunkLength;
        chunkLength = 0;
        if (sourceOffset < bytes.byteLength) yieldBeforeNextByte = true;
      }
    } else {
      for (const byte of bytes) {
        if (yieldBeforeNextByte) {
          await scheduler.yieldTask();
          if (!isCurrent()) throw new Error("文档解码已取消。");
          yieldBeforeNextByte = false;
        }
        chunk[chunkLength++] = byte;
        if (chunkLength !== chunk.length) continue;

        chunks.push(decoder.decode(chunk, {stream: true}));
        chunkLength = 0;
        yieldBeforeNextByte = true;
      }
    }

    if (chunkLength > 0) chunks.push(decoder.decode(chunk.subarray(0, chunkLength), {stream: true}));
    // Flush so a truncated final multibyte sequence is rejected with fatal UTF-8 decoding.
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    scheduler.close();
  }
}
