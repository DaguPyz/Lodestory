import {extractRichDeltaText} from "./richDeltaFormat";

self.onmessage = (event: MessageEvent<string>) => {
  const text = extractRichDeltaText(event.data);
  self.postMessage(text === undefined ? {error: "富文本格式或内容无效。"} : {text});
};
