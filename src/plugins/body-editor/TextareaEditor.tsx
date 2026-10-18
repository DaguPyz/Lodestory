import {useLayoutEffect, useMemo, useRef, useEffect} from "react";
import type {EditorHandle, EditorProps} from "@lodestory/sdk/body-editor";

/** 内置的纯文本适配器；后续编辑器插件使用相同的正文协议接入。 */
export function TextareaEditor({documentId, content, readOnly, active, onChange, onReady}: EditorProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const handle = useMemo<EditorHandle>(() => ({
    focus() {
      input.current?.focus({preventScroll: true});
    },
  }), []);

  useEffect(() => {
    onReady(handle);
    return () => onReady(null);
  }, [handle, onReady]);

  useLayoutEffect(() => {
    const element = input.current;
    if (!active || !element) return;
    let width = element.getBoundingClientRect().width;
    const resize = () => {
      element.style.height = "auto";
      element.style.height = Math.max(320, element.scrollHeight) + "px";
    };
    resize();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        const nextWidth = element.getBoundingClientRect().width;
        if (nextWidth === width) return;
        width = nextWidth;
        resize();
      });
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [active, content]);

  return <textarea
    ref={input}
    id={"editor-document-input-" + documentId}
    className="manuscript-body manuscript-input"
    aria-label="文档正文"
    placeholder="从这里开始写作…"
    value={content}
    readOnly={readOnly}
    onChange={event => onChange(event.target.value)}
    spellCheck={false}
  />;
}
