import {useEffect, useLayoutEffect, useRef, useState} from "react";
import type {EditorProps} from "@lodestory/sdk/body-editor";
import {createPlainTextDriver, type HighlightInspection, type PlainTextDriver, type SearchRequest} from "./plainTextDriver";
import {PlainTextHighlightCard} from "./PlainTextHighlightCard";
import {PlainTextSearchBar} from "./PlainTextSearchBar";
import "./plain-text-editor.css";

/** One document owns one input, viewport, text model and undo stack. */
export default function PlainTextEditor(props: EditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const driver = useRef<PlainTextDriver | undefined>(undefined);
  const accepted = useRef(props.content);
  const observedProp = useRef(props.content);
  const [search, setSearch] = useState<SearchRequest>();
  const [cards, setCards] = useState<HighlightInspection[]>([]);
  const [frontCard, setFrontCard] = useState<string>();

  useLayoutEffect(() => {
    const instance = driver.current;
    if (!instance) return;
    instance.setReadOnly(props.readOnly || !props.active);
    instance.setCompletion(props.completion);
    instance.setHighlights(props.active ? props.highlights : undefined);
    if (!props.active) instance.clearSearchMatch();
    if (props.content !== observedProp.current) {
      observedProp.current = props.content;
      if (props.content !== accepted.current) {
        instance.replaceContent(props.content);
        accepted.current = props.content;
      }
    }
  }, [props.content, props.readOnly, props.active, props.completion, props.highlights]);

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
        onOpenSearch(request) { if (alive && current.current.active) setSearch(request); },
        onInspect(inspection) {
          if (!alive || !current.current.active) return;
          const key = inspection.preview.key;
          setCards(open => open.some(item => item.preview.key === key) ? open : [...open, inspection]);
          setFrontCard(key);
        },
      });
      driver.current = instance;
      instance.setReadOnly(current.current.readOnly || !current.current.active);
      instance.setCompletion(current.current.completion);
      instance.setHighlights(current.current.active ? current.current.highlights : undefined);
      current.current.onReady({
        focus() { if (alive && current.current.active) instance?.focus(); },
        getContextMenuActions() {
          if (!alive || !instance?.canComplete()) return [];
          return [{id: "show-completion", label: "显示补全", restoreFocus: false, run: () => instance?.openCompletion()}];
        },
        revealSearchRange(target) {
          if (!alive || !instance || !current.current.active || instance.getContent() !== target.text
            || target.start < 0 || target.end <= target.start || target.end > target.text.length) return false;
          instance.setSelection(target.start, target.end, true, "center");
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

  function closeSearch() {
    setSearch(undefined);
    driver.current?.clearSearchMatch();
    if (props.active) driver.current?.focus();
  }

  return <div className="plain-text-editor" data-document-id={props.documentId} onKeyDown={event => {
    if (search && event.key === "Escape" && !event.defaultPrevented
      && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
      event.preventDefault();
      closeSearch();
    }
  }}>
    <PlainTextSearchBar request={search} driver={driver} readOnly={props.readOnly || !props.active} onClose={closeSearch} />
    <div className="plain-text-work-area">
      <div className="plain-text-document" ref={mount} />
      <div className="plain-text-highlight-cards" hidden={!props.active}>
        {cards.map(inspection => {
          const key = inspection.preview.key;
          return <PlainTextHighlightCard key={key} inspection={inspection} active={props.active} front={frontCard === key}
            onRaise={() => setFrontCard(key)} onClose={restoreFocus => {
              setCards(open => open.filter(item => item.preview.key !== key));
              if (restoreFocus && props.active) driver.current?.focus();
            }} />;
        })}
      </div>
    </div>
  </div>;
}
