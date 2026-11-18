import type {AssetCatalog, AssetCatalogSnapshot} from "@lodestory/sdk/asset-catalog";
import type {EditorCompletion, EditorHighlights} from "@lodestory/sdk/body-editor";
import type {AssetCompletionMessage, AssetCompletionReply, AssetTextQuery} from "./assetCompletionProtocol";

type Query = {
  message: AssetTextQuery;
  signal: AbortSignal;
  finish(reply?: AssetCompletionReply): void;
};

export function createAssetCompletionSource(catalog: AssetCatalog): EditorCompletion & {highlights: EditorHighlights; dispose(): void} {
  let snapshot = catalog.getSnapshot();
  const worker = new Worker(new URL("./assetCompletionWorker.ts", import.meta.url), {type: "module"});
  const listeners = new Set<() => void>();
  let alive = true;
  let pendingIndex: AssetCatalogSnapshot | undefined = snapshot;
  let inFlight: "index" | Query | undefined;
  const pending: Partial<Record<AssetTextQuery["kind"], Query>> = {};
  let unsubscribe = () => {};

  function available() { return alive && snapshot.loaded && snapshot.assets.length > 0; }
  function notify() { for (const listener of [...listeners]) listener(); }
  function cancelQueries() {
    pending.query?.finish();
    pending.highlight?.finish();
    delete pending.query;
    delete pending.highlight;
    if (inFlight && inFlight !== "index") inFlight.finish();
  }
  function dispose() {
    if (!alive) return;
    alive = false;
    try {
      unsubscribe();
    } finally {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      cancelQueries();
      pendingIndex = inFlight = undefined;
      try { notify(); } finally { listeners.clear(); }
    }
  }

  function post(message: AssetCompletionMessage) {
    try { worker.postMessage(message); } catch { dispose(); }
  }

  function pump() {
    if (!alive || inFlight) return;
    if (pendingIndex) {
      const {assets, types} = pendingIndex;
      pendingIndex = undefined;
      inFlight = "index";
      post({kind: "index", assets: assets.map(({name, typeId, color}) => ({name, typeId, color})),
        types: types.map(({id, name}) => ({id, name}))});
      return;
    }
    const query = pending.query ?? pending.highlight;
    if (!query) return;
    delete pending[query.message.kind];
    if (query.signal.aborted) { pump(); return; }
    inFlight = query;
    post(query.message);
  }

  worker.onmessage = (event: MessageEvent<AssetCompletionReply>) => {
    const job = inFlight;
    inFlight = undefined;
    if (job && job !== "index") job.finish(event.data);
    pump();
  };
  worker.onerror = event => { event.preventDefault(); dispose(); };
  worker.onmessageerror = dispose;
  try {
    unsubscribe = catalog.subscribe(() => {
      const next = catalog.getSnapshot();
      if (snapshot.assets === next.assets && snapshot.types === next.types && snapshot.loaded === next.loaded) return;
      snapshot = next;
      pendingIndex = next;
      cancelQueries();
      notify();
      pump();
    });
    pump();
  } catch (error) {
    dispose();
    throw error;
  }

  function request<Result>(kind: AssetTextQuery["kind"], text: string, signal: AbortSignal,
    resultOf: (reply: AssetCompletionReply) => readonly Result[]): Promise<readonly Result[]> {
    if (!available() || signal.aborted) return Promise.resolve([]);
    return new Promise(resolve => {
      function abort() { finish(); }
      function finish(reply?: AssetCompletionReply) {
        signal.removeEventListener("abort", abort);
        resolve(reply && !signal.aborted ? resultOf(reply) : []);
      }
      signal.addEventListener("abort", abort, {once: true});
      pending[kind]?.finish();
      pending[kind] = {message: {kind, text}, signal, finish};
      pump();
    });
  }
  function subscribe(listener: () => void) {
    if (!alive) return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  return {
    isAvailable: available, subscribe,
    query: (text, signal) => request("query", text, signal, reply => reply.kind === "candidates" ? reply.candidates : []),
    highlights: {
      isAvailable: available, subscribe,
      query: (text, signal) => request("highlight", text, signal, reply => reply.kind === "highlights" ? reply.highlights : []),
    },
    dispose,
  };
}
