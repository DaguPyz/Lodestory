import {runTextWorker} from "../../utils/runTextWorker";
import {extractRichDeltaText} from "./richDeltaFormat";
import RichSearchWorker from "./richSearchWorker?worker&inline";

export function extractRichSearchText(content: string, signal?: AbortSignal): Promise<string> {
  if (typeof Worker === "undefined") return Promise.resolve().then(() => {
    if (signal?.aborted) throw new Error("正文搜索已取消。");
    const text = extractRichDeltaText(content);
    if (text === undefined) throw new Error("富文本格式或内容无效。");
    return text;
  });
  return runTextWorker(() => new RichSearchWorker(), content, signal);
}
