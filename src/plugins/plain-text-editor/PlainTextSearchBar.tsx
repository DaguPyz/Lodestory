import type {Translate} from "@lodestory/sdk/i18n";
import {useLayoutEffect, useRef, useState, type RefObject} from "react";
import {Icon, IconButton, TextField} from "@lodestory/ui";
import type {PlainTextDriver, SearchOptions, SearchRequest} from "./plainTextDriver";

const flags = [
  ["caseSensitive", "区分大小写", "matchCase"],
  ["regexp", "正则表达式", "regexp"],
  ["wholeWord", "全词匹配", "wholeWord"],
] as const;

export function PlainTextSearchBar({t, request, driver, readOnly, onClose}: {
  t: Translate;
  request?: SearchRequest;
  driver: RefObject<PlainTextDriver | undefined>;
  readOnly: boolean;
  onClose(): void;
}) {
  const query = useRef<HTMLInputElement>(null);
  const replacement = useRef<HTMLInputElement>(null);
  const [options, setOptions] = useState<SearchOptions>({});
  const [status, setStatus] = useState("");

  function resetMatch() {
    driver.current?.clearSearchMatch();
    setStatus("");
  }

  useLayoutEffect(() => {
    if (!request || !query.current) return;
    if (request.selected && request.selected !== query.current.value) {
      query.current.value = request.selected;
      driver.current?.clearSearchMatch();
    }
    const field = request.replace ? replacement.current : query.current;
    field?.focus({preventScroll: true});
    field?.select();
  }, [request, driver]);

  function run(action: "next" | "previous" | "replace" | "replaceAll") {
    const instance = driver.current;
    const text = query.current?.value ?? "";
    const inserted = replacement.current?.value ?? "";
    if (!instance) return;
    try {
      if (action === "replaceAll") {
        instance.replaceAllSearchMatches(text, inserted, options);
        setStatus("");
        return;
      }
      if (action === "replace") instance.replaceSearchMatch(text, inserted, options);
      const found = instance.find(text, action === "previous", options);
      setStatus(found ? "" : "未找到匹配项");
    } catch {
      instance.clearSearchMatch();
      setStatus("查找表达式无效");
    }
  }

  return <div className="plain-text-search" role="search" hidden={!request}>
    <div className="plain-text-search-group">
      <TextField type="search" ref={query} placeholder={t("查找")} aria-label={t("查找文本")} onInput={resetMatch} onKeyDown={event => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        run(event.shiftKey ? "previous" : "next");
      }} />
      <IconButton label={t("上一个")} onClick={() => run("previous")}><Icon name="chevronUp" /></IconButton>
      <IconButton label={t("下一个")} onClick={() => run("next")}><Icon name="chevronDown" /></IconButton>
    </div>
    <div className="plain-text-search-group">
      <TextField ref={replacement} placeholder={t("替换为")} aria-label={t("替换文本")} />
      <IconButton label={t("替换")} disabled={readOnly} onClick={() => run("replace")}><Icon name="replace" /></IconButton>
      <IconButton label={t("全部替换")} disabled={readOnly} onClick={() => run("replaceAll")}><Icon name="replaceAll" /></IconButton>
    </div>
    <div className="plain-text-search-group">
      {flags.map(([name, label, icon]) => <IconButton key={name} label={t(label)} aria-pressed={options[name] ?? false} onClick={() => {
        setOptions(current => ({...current, [name]: !current[name]}));
        resetMatch();
      }}><Icon name={icon} /></IconButton>)}
    </div>
    <IconButton label={t("关闭查找")} onClick={onClose}><Icon name="close" /></IconButton>
    <span role="status">{t(status)}</span>
  </div>;
}
