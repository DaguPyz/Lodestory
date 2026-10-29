import {markdownSearchText} from "./markdownSearchText";

self.onmessage = (event: MessageEvent<string>) => {
  try { self.postMessage({text: markdownSearchText(event.data)}); }
  catch (error) { self.postMessage({error: error instanceof Error ? error.message : "Markdown 正文无法解析。"}); }
};
