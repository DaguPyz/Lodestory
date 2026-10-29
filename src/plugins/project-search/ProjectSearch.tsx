import {useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore} from "react";
import type {ProjectSearchResult, ProjectSearchService} from "@lodestory/sdk/project-search";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import {Button, Dialog, DialogActions, SearchField} from "@lodestory/ui";
import {highlightMatches} from "./highlightMatches";
import "./project-search.css";

function highlighted(text: string, query: string) {
  return highlightMatches(text, query).map((part, index) => part.matched
    ? <mark key={index} className="project-search-match">{part.text}</mark> : part.text);
}

export function ProjectSearch({search, workbench, requests}: {search: ProjectSearchService; workbench: WorkbenchService; requests: {subscribe(listener: (sessionId: string) => void): () => void}}) {
  const workbenchState = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  const sessionId = workbenchState.session?.id ?? "";
  const snapshot = useSyncExternalStore(search.subscribe, () => search.getSnapshot(sessionId), () => search.getSnapshot(sessionId));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [results, setResults] = useState<readonly ProjectSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  useEffect(() => requests.subscribe(id => {
    if (id === currentSession.current) { setQuery(""); setKind(""); setError(""); setOpen(true); }
  }), [requests]);
  useEffect(() => { setOpen(false); setOpening(false); }, [sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    if (!query.trim() || !sessionId) { setResults([]); setSearching(false); return () => controller.abort(); }
    setResults([]);
    setSearching(true);
    void search.searchAsync(sessionId, query, kind || undefined, controller.signal, next => {
      if (!controller.signal.aborted) setResults(next);
    }).catch(() => { if (!controller.signal.aborted) setError("搜索失败，请重试。"); })
      .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    return () => controller.abort();
  }, [search, sessionId, query, kind, snapshot]);
  const visibleResults = results.slice(0, 200);
  const groups = [...new Set(visibleResults.map(result => result.kind))];
  useLayoutEffect(() => {
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
  }, [query, kind]);
  async function openResult(result: ProjectSearchResult) {
    if (opening) return;
    const requestedSession = sessionId;
    setOpening(true); setError("");
    try {
      const opened = await search.open(sessionId, result.sourceId, result.id, result.match);
      if (requestedSession !== currentSession.current) return;
      if (opened) setOpen(false);
      else setError("无法打开此结果，请确认资源仍然存在且当前编辑已完成。");
    } catch { if (requestedSession === currentSession.current) setError("打开结果失败，请重试。"); }
    finally { if (requestedSession === currentSession.current) setOpening(false); }
  }
  function resultItem(result: ProjectSearchResult, grouped = false) {
    return <li key={`${result.sourceId}:${result.id}:${result.match?.start ?? ""}`}>
      <button type="button" disabled={opening} onClick={() => void openResult(result)}>
        {!grouped && <span className="project-search-title">{highlighted(result.title, query)}</span>}
        <span className="project-search-detail">{highlighted(result.detail, query)}{result.kind === "事件" ? " · 打开所属时间线" : ""}</span>
      </button>
    </li>;
  }
  function resultGroup(group: string) {
    const rows = visibleResults.filter(result => result.kind === group);
    const ordinary = rows.filter(result => !result.match);
    const documents = new Map<string, ProjectSearchResult[]>();
    for (const row of rows.filter(result => result.match)) {
      const key = `${row.sourceId}:${row.id}`;
      const matches = documents.get(key) ?? [];
      matches.push(row); documents.set(key, matches);
    }
    return <section key={group} className="project-search-group"><h2>{group}</h2>
      {ordinary.length > 0 && <ul>{ordinary.map(row => resultItem(row))}</ul>}
      {[...documents.entries()].map(([key, matches]) => <section key={key} className="project-search-document">
        <h3>{matches[0].title} <span>{matches[0].id}</span></h3>
        <ul>{matches.map(row => resultItem(row, true))}</ul>
      </section>)}
    </section>;
  }
  return <Dialog open={open && workbenchState.active && !!sessionId} onOpenChange={setOpen} title="搜索项目" size="wide"
    description="查找文件、正文、资产和时间线事件。">
    <div className="project-search">
      <SearchField label="搜索项目资源" placeholder="输入名称、正文或资产内容" value={query} autoFocus
        onChange={event => setQuery(event.currentTarget.value)}/>
      <div className="project-search-filters" aria-label="结果类型">
        {[{id: "", label: "全部"}, {id: "文件", label: "文件"}, {id: "正文", label: "正文"}, {id: "资产", label: "资产"}, {id: "时间线", label: "时间线"}, {id: "事件", label: "事件"}].map(option =>
          <Button key={option.id} variant="ghost" aria-pressed={kind === option.id} onClick={() => setKind(option.id)}>{option.label}</Button>)}
      </div>
      <div ref={resultsRef} className="project-search-results" aria-live="polite">
        {(snapshot.indexing || searching) && <p className="project-search-status" role="status">正在搜索项目资源，结果可能不完整。
          {snapshot.progress?.map(progress => ` ${progress.title} ${progress.completed}/${progress.total}`)}</p>}
        {snapshot.issues.length > 0 && <div className="project-search-issues" role="status"><p>部分资源未能加载，搜索结果可能不完整。</p>{snapshot.issues.map(issue => <p key={issue}>{issue}</p>)}</div>}
        {error && <p className="project-search-error" role="alert">{error}</p>}
        {!query.trim() ? <p className="project-search-empty">输入关键词开始搜索。</p>
          : results.length === 0 ? <p className="project-search-empty">{searching || snapshot.indexing ? "正在搜索…" : "没有找到匹配的资源。"}</p>
          : groups.map(resultGroup)}
        {results.length > visibleResults.length && <p className="project-search-status">仅显示前 {visibleResults.length} 条；可缩小搜索范围。</p>}
      </div>
      <DialogActions><Button variant="ghost" disabled={opening} onClick={() => void search.refresh(sessionId).catch(() => setError("刷新失败，请重试。"))}>刷新文件列表</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>关闭</Button></DialogActions>
    </div>
  </Dialog>;
}
