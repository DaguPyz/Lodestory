/** Packs cards into the shortest column while preserving their DOM and focus order. */
export function observeAssetCardMasonry(list: HTMLUListElement): () => void {
  const view = list.ownerDocument.defaultView;
  if (!view || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return () => {};

  const observed = new Set<HTMLElement>();
  let stopped = false;
  let frame = 0;
  let observedWidth = -1;

  function restore(card: HTMLElement) {
    card.style.removeProperty("position");
    card.style.removeProperty("width");
    card.style.removeProperty("inset-inline-start");
    card.style.removeProperty("top");
  }

  function schedule() {
    if (!stopped && !frame) frame = view!.requestAnimationFrame(layout);
  }

  const resize = new ResizeObserver(entries => {
    const changed = entries.some(entry => {
      if (entry.target !== list) return true;
      // Updating the list's height must not schedule another layout indefinitely.
      if (entry.contentRect.width === observedWidth) return false;
      observedWidth = entry.contentRect.width;
      return true;
    });
    if (changed) schedule();
  });
  const mutations = new MutationObserver(schedule);

  function layout() {
    frame = 0;
    if (stopped || list.clientWidth === 0) return;
    const cards = Array.from(list.children) as HTMLElement[];
    const current = new Set(cards);
    for (const card of observed) {
      if (current.has(card)) continue;
      resize.unobserve(card);
      restore(card);
      observed.delete(card);
    }
    for (const card of cards) {
      if (observed.has(card)) continue;
      observed.add(card);
      resize.observe(card);
    }

    // CSS owns the responsive column count. WebKit's resolved grid tracks omit
    // gaps once all cards are absolutely positioned, so calculate widths from
    // the list's content box instead of reusing those resolved track widths.
    const styles = view!.getComputedStyle(list);
    const tracks = styles.gridTemplateColumns.split(/\s+/).map(value => Number.parseFloat(value));
    if (!tracks.length || tracks.some(width => !Number.isFinite(width) || width <= 0)) return;
    const gap = Number.parseFloat(styles.columnGap) || 0;
    const width = (Number.parseFloat(styles.width) - gap * (tracks.length - 1)) / tracks.length;
    if (!Number.isFinite(width) || width <= 0) return;
    const heights = tracks.map(() => 0);

    // Every track is equally wide. Write widths together, then read intrinsic card heights together.
    for (const card of cards) card.style.width = `${width}px`;
    const cardHeights = cards.map(card => card.getBoundingClientRect().height);
    cards.forEach((card, index) => {
      let column = 0;
      for (let next = 1; next < heights.length; next++) {
        if (heights[next] < heights[column]) column = next;
      }
      card.style.position = "absolute";
      card.style.insetInlineStart = `${column * (width + gap)}px`;
      card.style.top = `${heights[column]}px`;
      heights[column] += cardHeights[index] + gap;
    });
    list.style.height = `${Math.max(0, ...heights) - (cards.length ? gap : 0)}px`;
    list.dataset.masonryReady = "true";
  }

  resize.observe(list);
  mutations.observe(list, {childList: true});
  layout();
  return () => {
    stopped = true;
    if (frame) view.cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    for (const card of observed) restore(card);
    observed.clear();
    list.style.removeProperty("height");
    delete list.dataset.masonryReady;
  };
}
