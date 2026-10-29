import {useEffect, useLayoutEffect, useRef} from "react";
import type {EditorProps} from "@lodestory/sdk/body-editor";
import {createPlainTextDriver, type PlainTextDriver} from "./plainTextDriver";
import "./plain-text-editor.css";

/** One document owns one input, viewport, text model and undo stack. */
export default function PlainTextEditor(props: EditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const driver = useRef<PlainTextDriver | undefined>(undefined);
  const accepted = useRef(props.content);
  const observedProp = useRef(props.content);

  useLayoutEffect(() => {
    const instance = driver.current;
    if (!instance) return;
    instance.setReadOnly(props.readOnly || !props.active);
    if (props.content !== observedProp.current) {
      observedProp.current = props.content;
      if (props.content !== accepted.current) {
        instance.replaceContent(props.content);
        accepted.current = props.content;
      }
    }
  }, [props.content, props.readOnly, props.active]);

  useEffect(() => {
    const root = mount.current;
    if (!root) return;
    let alive = true;
    let instance: PlainTextDriver | undefined;
    try {
      if (current.current.format !== "plain-text") throw new Error("纯文本编辑器仅支持 TXT 文档。");
      accepted.current = current.current.content;
      observedProp.current = current.current.content;
      instance = createPlainTextDriver(root, accepted.current, {
        onChange(content) {
          if (!alive || current.current.readOnly || !current.current.active) return;
          accepted.current = content;
          current.current.onChange(content);
        },
        onError(error) { if (alive) current.current.onError(error); },
      });
      driver.current = instance;
      instance.setReadOnly(current.current.readOnly || !current.current.active);
      current.current.onReady({
        focus() { if (alive && current.current.active) instance?.focus(); },
        revealSearchRange(target) {
          if (!alive || !instance || !current.current.active || instance.getContent() !== target.text
            || target.start < 0 || target.end <= target.start || target.end > target.text.length) return false;
          instance.setSelection(target.start, target.end);
          instance.focus();
          return true;
        },
        flushContent(currentContent?: string) {
          if (!alive || !instance) throw new Error("纯文本编辑器已关闭。");
          if (currentContent !== undefined && currentContent !== accepted.current) {
            instance.replaceContent(currentContent);
            accepted.current = currentContent;
          }
          return instance.flushContent();
        },
      });
    } catch (reason) {
      instance?.destroy();
      current.current.onError(reason instanceof Error ? reason : new Error(String(reason)));
    }
    return () => {
      alive = false;
      if (driver.current === instance) driver.current = undefined;
      current.current.onReady(null);
      instance?.destroy();
    };
  }, [props.documentId, props.format]);

  return <div className="plain-text-editor" ref={mount} data-document-id={props.documentId} />;
}
