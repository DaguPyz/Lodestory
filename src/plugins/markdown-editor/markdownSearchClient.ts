import {runTextWorker} from "../../utils/runTextWorker";
import {markdownSearchText} from "./markdownSearchText";
import MarkdownSearchWorker from "./markdownSearchWorker?worker&inline";

export function extractMarkdownSearchText(content: string, signal?: AbortSignal): Promise<string> {
  if (typeof Worker === "undefined") return Promise.resolve().then(() => {
    if (signal?.aborted) throw new Error("正文搜索已取消。");
    return markdownSearchText(content);
  });
  return runTextWorker(() => new MarkdownSearchWorker(), content, signal);
}
