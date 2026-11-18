import type {AssetCatalog, AssetCatalogSnapshot} from "@lodestory/sdk/asset-catalog";
import type {EditorCompletion, EditorCompletionCandidate} from "@lodestory/sdk/body-editor";
import type {AssetCompletionMessage, AssetCompletionReply} from "./assetCompletionProtocol";

type Query = {
  textBefore: string;
  signal: AbortSignal;
  finish(candidates: readonly EditorCompletionCandidate[]): void;
};

export function createAssetCompletionSource(catalog: AssetCatalog): EditorCompletion & {dispose(): void} {
  let snapshot = catalog.getSnapshot();
  const worker = new Worker(new URL("./assetCompletionWorker.ts", import.meta.url), {type: "module"});
  const listeners = new Set<() => void>();
  let alive = true;
  let pendingIndex: AssetCatalogSnapshot | undefined = snapshot;
  let inFlight: "index" | Query | undefined;
  let pendingQuery: Query | undefined;
  let unsubscribe = () => {};

  function available() { return alive && snapshot.loaded && snapshot.assets.length > 0; }
  function notify() { for (const listener of [...listeners]) listener(); }
  function dispose() {
    if (!alive) return;
    alive = false;
    try {
      unsubscribe();
    } finally {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      pendingQuery?.finish([]);
      if (inFlight && inFlight !== "index") inFlight.finish([]);
      pendingQuery = pendingIndex = inFlight = undefined;
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
      post({kind: "index", assets: assets.map(({name, typeId}) => ({name, typeId})),
        types: types.map(({id, name}) => ({id, name}))});
    } else if (pendingQuery) {
      const query = pendingQuery;
      pendingQuery = undefined;
      if (query.signal.aborted) return;
      inFlight = query;
      post({kind: "query", textBefore: query.textBefore});
    }
  }

  worker.onmessage = (event: MessageEvent<AssetCompletionReply>) => {
    const job = inFlight;
    inFlight = undefined;
    if (job && job !== "index") job.finish(event.data.kind === "candidates" ? event.data.candidates : []);
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
      pendingQuery?.finish([]);
      pendingQuery = undefined;
      if (inFlight && inFlight !== "index") inFlight.finish([]);
      notify();
      pump();
    });
    pump();
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    isAvailable: available,
    subscribe(listener) {
      if (!alive) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    query(textBefore, signal) {
      if (!available() || signal.aborted) return Promise.resolve([]);
      return new Promise(resolve => {
        function abort() { finish([]); }
        function finish(candidates: readonly EditorCompletionCandidate[]) {
          signal.removeEventListener("abort", abort);
          resolve(signal.aborted ? [] : candidates);
        }
        signal.addEventListener("abort", abort, {once: true});
        pendingQuery?.finish([]);
        pendingQuery = {textBefore, signal, finish};
        pump();
      });
    },
    dispose,
  };
}
