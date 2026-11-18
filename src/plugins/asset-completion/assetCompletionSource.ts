import type {AssetCatalog, AssetCatalogAssetDetails, AssetCatalogSnapshot} from "@lodestory/sdk/asset-catalog";
import type {EditorCompletion, EditorHighlightInfo, EditorHighlightInfoSection, EditorHighlightPreview, EditorHighlights} from "@lodestory/sdk/body-editor";
import type {AssetCompletionMessage, AssetCompletionReply, AssetTextHighlight, AssetTextQuery} from "./assetCompletionProtocol";

type Query = {
  message: AssetTextQuery;
  signal: AbortSignal;
  finish(reply?: AssetCompletionReply): void;
};
const emptyPreview: readonly EditorHighlightInfo[] = [];

export function createAssetCompletionSource(catalog: AssetCatalog): EditorCompletion & {highlights: EditorHighlights; dispose(): void} {
  let snapshot = catalog.getSnapshot();
  const details = catalog.details;
  const worker = new Worker(new URL("./assetCompletionWorker.ts", import.meta.url), {type: "module"});
  const listeners = new Set<() => void>();
  let alive = true;
  let pendingIndex: AssetCatalogSnapshot | undefined = snapshot;
  let inFlight: "index" | Query | undefined;
  const pending: Partial<Record<AssetTextQuery["kind"], Query>> = {};
  let unsubscribe = () => {};
  let previewLookup: ReturnType<typeof indexPreviewMetadata> | undefined;

  function available() { return alive && snapshot.loaded && !snapshot.blocked && snapshot.assets.length > 0; }
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
      previewLookup = undefined;
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
      post({kind: "index", assets: assets.map(({id, name, typeId, color}) => ({id, name, typeId, color})),
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
      const indexChanged = snapshot.assets !== next.assets || snapshot.types !== next.types || snapshot.loaded !== next.loaded;
      if (!indexChanged && snapshot.blocked === next.blocked) return;
      snapshot = next;
      previewLookup = undefined;
      if (indexChanged) {
        pendingIndex = next;
        cancelQueries();
      }
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
  function createPreview(ids: readonly string[]): EditorHighlightPreview {
    let last: AssetCatalogSnapshot | undefined;
    let lastDetails: readonly (AssetCatalogAssetDetails | null)[] | undefined;
    let info = emptyPreview;
    return {
      key: ids.join(","),
      subscribe(listener) {
        if (!alive) return () => {};
        const unsubscribeDetails = details?.subscribe(listener);
        const unsubscribeMetadata = subscribe(listener);
        return () => {
          try { unsubscribeDetails?.(); } finally { unsubscribeMetadata(); }
        };
      },
      getSnapshot() {
        if (!alive || !snapshot.loaded || snapshot.blocked) return emptyPreview;
        const currentDetails = details && ids.map(id => details.getSnapshot(id));
        if (last !== snapshot || currentDetails?.some((value, index) => value !== lastDetails?.[index])) {
          const {assets, types} = previewLookup ??= indexPreviewMetadata(snapshot);
          info = ids.flatMap((id, index) => {
            const asset = assets.get(id);
            if (!asset) return [];
            const fields = currentDetails?.[index];
            const sections: EditorHighlightInfoSection[] = [{id: "color", fields: [
              {id: "color", label: "颜色标记", value: asset.color?.toUpperCase() ?? "默认"},
            ]}];
            if (fields?.templateFields.length) sections.push({id: "template", title: "模板字段", fields: fields.templateFields});
            if (fields?.customFields.length) sections.push({id: "custom", title: "专属属性", fields: fields.customFields});
            return [{id, title: asset.name, description: asset.description,
              subtitle: (asset.typeId && types.get(asset.typeId)) || "未分类", sections}];
          });
          last = snapshot;
          lastDetails = currentDetails;
        }
        return info;
      },
    };
  }
  function attachPreviews(highlights: readonly AssetTextHighlight[]) {
    const previews = new Map<readonly string[], EditorHighlightPreview>();
    return highlights.map(({assetIds, ...highlight}) => {
      let preview = previews.get(assetIds);
      if (!preview) {
        preview = createPreview(assetIds);
        previews.set(assetIds, preview);
      }
      return {...highlight, preview};
    });
  }
  return {
    isAvailable: available, subscribe,
    query: (text, signal) => request("query", text, signal, reply => reply.kind === "candidates" ? reply.candidates : []),
    highlights: {
      isAvailable: available, subscribe,
      query: (text, signal) => request("highlight", text, signal, reply => reply.kind === "highlights" ? attachPreviews(reply.highlights) : []),
    },
    dispose,
  };
}

function indexPreviewMetadata(snapshot: AssetCatalogSnapshot) {
  return {assets: new Map(snapshot.assets.map(asset => [asset.id, asset])),
    types: new Map(snapshot.types.map(type => [type.id, type.name]))};
}
