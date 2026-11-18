import type {EditorCompletion, EditorCompletionCandidate} from "@lodestory/sdk/body-editor";

type CompletionContext = {head: number; textBefore: string};
const maxVisibleRows = 10;
let nextListId = 0;

export function createPlainTextCompletion(
  root: HTMLElement, viewport: HTMLElement, caret: HTMLElement, input: HTMLTextAreaElement,
  source: EditorCompletion, getContext: () => CompletionContext | undefined,
  apply: (candidate: EditorCompletionCandidate, head: number) => boolean,
) {
  const list = document.createElement("div");
  list.className = "plain-text-completion";
  list.id = `plain-text-completion-${++nextListId}`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "正文补全");
  list.hidden = true;
  const scroll = document.createElement("div");
  scroll.className = "plain-text-completion-scroll";
  scroll.setAttribute("role", "presentation");
  const items = document.createElement("div");
  items.className = "plain-text-completion-items";
  items.setAttribute("role", "presentation");
  scroll.append(items);
  list.append(scroll);
  root.append(list);
  let request: AbortController | undefined;
  let candidates: readonly EditorCompletionCandidate[] = [];
  let head = 0;
  let selected = -1;
  let rowHeight = 0;
  let visibleHeight = 0;
  let rendered = "";

  function close() {
    if (!request && list.hidden) return;
    request?.abort();
    request = undefined;
    candidates = [];
    selected = -1;
    rendered = "";
    list.hidden = true;
    items.replaceChildren();
    input.removeAttribute("aria-activedescendant");
  }

  function refreshAvailability() {
    close();
    if (source.isAvailable()) {
      input.setAttribute("aria-autocomplete", "list");
      input.setAttribute("aria-controls", list.id);
    } else {
      input.removeAttribute("aria-autocomplete");
      input.removeAttribute("aria-controls");
    }
  }
  const unsubscribe = source.subscribe(refreshAvailability);
  refreshAvailability();

  function position() {
    if (list.hidden) return;
    const anchor = caret.getBoundingClientRect();
    const area = viewport.getBoundingClientRect();
    const origin = root.getBoundingClientRect();
    const top = Math.max(0, area.top);
    const bottom = Math.min(window.innerHeight, area.top + viewport.clientHeight);
    const left = Math.max(0, area.left) + 8;
    const right = Math.min(window.innerWidth, area.left + viewport.clientWidth) - 8;
    const below = bottom - anchor.bottom - 8;
    const above = anchor.top - top - 8;
    if (caret.hidden || anchor.top < top || anchor.bottom > bottom || right <= left || Math.max(above, below) < 32) {
      close();
      return;
    }
    list.style.maxWidth = `${right - left}px`;
    rowHeight = items.firstElementChild!.getBoundingClientRect().height;
    const style = getComputedStyle(list);
    const frameHeight = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const wantedRows = Math.min(maxVisibleRows, candidates.length);
    const flip = below < wantedRows * rowHeight + frameHeight && above > below;
    const rows = Math.min(wantedRows, Math.floor(((flip ? above : below) - frameHeight) / rowHeight));
    if (!(rows > 0)) { close(); return; }
    visibleHeight = rows * rowHeight;
    scroll.style.maxHeight = `${visibleHeight}px`;
    items.style.height = `${candidates.length * rowHeight}px`;
    list.style.left = `${Math.max(left, Math.min(anchor.left, right - list.offsetWidth)) - origin.left}px`;
    list.style.top = `${(flip ? anchor.top - list.offsetHeight - 4 : anchor.bottom + 4) - origin.top}px`;
    renderRows();
  }

  function createRow(index: number) {
    const item = candidates[index];
    const row = document.createElement("div");
    row.className = "plain-text-completion-option";
    row.id = `${list.id}-${index}`;
    row.dataset.index = String(index);
    row.style.top = `${index * rowHeight}px`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selected));
    row.setAttribute("aria-posinset", String(index + 1));
    row.setAttribute("aria-setsize", String(candidates.length));
    const label = document.createElement("span");
    label.className = "plain-text-completion-name";
    if (item.label.startsWith(item.match)) {
      const match = document.createElement("strong");
      match.textContent = item.match;
      label.append(match, item.label.slice(item.match.length));
    } else label.textContent = item.label;
    row.append(label);
    if (item.detail) {
      const detail = document.createElement("span");
      detail.className = "plain-text-completion-detail";
      detail.textContent = item.detail;
      row.append(detail);
    }
    return row;
  }

  function renderRows() {
    if (list.hidden) return;
    const first = Math.max(0, Math.floor(scroll.scrollTop / rowHeight) - 1);
    const end = Math.min(candidates.length, Math.ceil((scroll.scrollTop + visibleHeight) / rowHeight) + 1);
    const key = `${first}:${end}:${selected}:${rowHeight}`;
    if (rendered === key) return;
    rendered = key;
    const rows = document.createDocumentFragment();
    if (selected >= 0 && selected < first) rows.append(createRow(selected));
    for (let index = first; index < end; index++) rows.append(createRow(index));
    if (selected >= end) rows.append(createRow(selected));
    items.replaceChildren(rows);
  }

  function choose(index: number) {
    const candidate = candidates[index];
    if (!candidate) return false;
    close();
    return apply(candidate, head);
  }

  function highlight(index: number) {
    selected = index;
    const top = index * rowHeight;
    scroll.scrollTop = Math.max(top + rowHeight - visibleHeight, Math.min(top, scroll.scrollTop));
    renderRows();
    input.setAttribute("aria-activedescendant", `${list.id}-${index}`);
  }

  scroll.addEventListener("scroll", renderRows);
  list.addEventListener("pointerdown", event => event.preventDefault());
  list.addEventListener("click", event => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-index]") : null;
    if (row?.parentElement === items) choose(Number(row.dataset.index));
  });

  return {
    close,
    position,
    isAvailable: () => source.isAvailable(),
    request(automatic: boolean) {
      close();
      const context = getContext();
      if (!context?.textBefore || !source.isAvailable()) return;
      if (automatic && !/[\p{L}\p{N}]$/u.test(context.textBefore)) return;
      const pending = new AbortController();
      request = pending;
      void Promise.resolve().then(() => {
        if (!pending.signal.aborted) return source.query(context.textBefore, pending.signal);
      }).then(results => {
        if (request !== pending) return;
        request = undefined;
        if (getContext()?.head !== context.head || !results?.length) return;
        candidates = results.filter(item => item.match && context.textBefore.endsWith(item.match)
          && item.insertText !== item.match && item.label);
        if (!candidates.length) return;
        head = context.head;
        items.style.height = "";
        items.replaceChildren(createRow(0));
        list.hidden = false;
        scroll.scrollTop = 0;
        position();
      }).catch(() => { if (request === pending) close(); });
    },
    handleKey(event: KeyboardEvent) {
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
      const {key} = event;
      if (key === "Escape" && (request || !list.hidden)) { close(); return true; }
      if (list.hidden) return false;
      if (key === "Enter" && selected >= 0) return choose(selected);
      if (key !== "ArrowDown" && key !== "ArrowUp") return false;
      const index = key === "ArrowDown"
        ? Math.min(selected + 1, candidates.length - 1)
        : selected < 0 ? candidates.length - 1 : Math.max(0, selected - 1);
      highlight(index);
      return true;
    },
    destroy() {
      try { unsubscribe(); } finally {
        close();
        input.removeAttribute("aria-autocomplete");
        input.removeAttribute("aria-controls");
        list.remove();
      }
    },
  };
}
