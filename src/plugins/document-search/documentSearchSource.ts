import type {BodyEditorService} from "@lodestory/sdk/body-editor";
import type {DocumentWorkspace, ProjectDocumentCatalog, ProjectDocumentEntry} from "@lodestory/sdk/documents";
import type {ProjectSearchRecord, ProjectSearchSource} from "@lodestory/sdk/project-search";

type Item = { path: string; name: string; text: string };

/** Derives read-only search text from the owning document and format services. */
export function createDocumentSearchSource(sessionId: string, catalog: ProjectDocumentCatalog, workspace: DocumentWorkspace, editor: BodyEditorService) {
    let alive = true;
    let generation = 0;
    let running = false;
    let processingPath: string | null = null;
    let processingController: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let entries = new Map<string, string>();
    const items = new Map<string, Item>();
    const errors = new Map<string, string>();
    const pending = new Map<string, number>();
    const versions = new Map<string, number>();
    const listeners = new Set<() => void>();
    const opening = new Set<AbortController>();
    let priorDocuments = new Map<string, string>();

    function notify() {
        for (const listener of [...listeners]) listener();
    }

    function schedule(path: string) {
        if (!entries.has(path)) return;
        if (processingPath === path) processingController?.abort();
        const version = (versions.get(path) ?? 0) + 1;
        versions.set(path, version);
        pending.set(path, version);
        if (!running && timer === undefined) timer = setTimeout(() => {
            timer = undefined;
            void process();
        }, 0);
    }

    async function process() {
        if (!alive || running) return;
        running = true;
        const localGeneration = generation;
        try {
            while (alive && localGeneration === generation && pending.size) {
                const [path, version] = pending.entries().next().value as [string, number];
                pending.delete(path);
                processingPath = path;
                processingController = new AbortController();
                const signal = processingController.signal;
                const name = entries.get(path);
                if (!name) continue;
                let content: string | null = null;
                let text: string | undefined;
                try {
                    content = await workspace.readSearchText(path, signal);
                    if (!signal.aborted) text = content === null ? undefined : await editor.getSearchText(name, content, signal);
                } catch { /* A single unreadable document must not stop the remaining queue. */
                }
                if (!alive || localGeneration !== generation) break;
                if (versions.get(path) !== version || !entries.has(path)) continue;
                if (content === null || text === undefined) {
                    items.delete(path);
                    errors.set(path, "无法读取或解析正文");
                } else {
                    items.set(path, {path, name, text});
                    errors.delete(path);
                }
                processingPath = null;
                processingController = null;
                notify();
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        } finally {
            processingPath = null;
            processingController = null;
            running = false;
            if (alive && pending.size && timer === undefined) timer = setTimeout(() => {
                timer = undefined;
                void process();
            }, 0);
            if (alive) notify();
        }
    }

    function syncCatalog(force = false) {
        const next = new Map<string, string>();

        function collect(nodes: readonly ProjectDocumentEntry[]) {
            for (const node of nodes) {
                if (node.children) collect(node.children);
                else next.set(node.path, node.name);
            }
        }

        collect(catalog.getSnapshot().entries);
        for (const path of entries.keys()) if (!next.has(path)) {
            if (processingPath === path) processingController?.abort();
            versions.set(path, (versions.get(path) ?? 0) + 1);
            pending.delete(path);
            items.delete(path);
            errors.delete(path);
        }
        const previous = entries;
        entries = next;
        for (const [path, name] of next) if (force || previous.get(path) !== name) schedule(path);
        notify();
    }

    function syncDocuments() {
        const next = new Map(workspace.getSnapshot().documents.map(document => [document.path, document.content]));
        let changed = false;
        for (const [path, content] of next) if (priorDocuments.get(path) !== content) {
            schedule(path);
            changed = true;
        }
        priorDocuments = next;
        if (changed) notify();
    }

    let previousCatalog = catalog.getSnapshot();
    const stopCatalog = catalog.subscribe(() => {
        const next = catalog.getSnapshot();
        if (next.entries !== previousCatalog.entries || next.loading !== previousCatalog.loading || next.error !== previousCatalog.error) syncCatalog();
        previousCatalog = next;
    });
    const stopWorkspace = workspace.subscribe(syncDocuments);
    syncCatalog();
    syncDocuments();
    const source: ProjectSearchSource = {
        title: "文档正文",
        getSnapshot() {
            const state = catalog.getSnapshot();
            const records: ProjectSearchRecord[] = [...items.values()].map(item => ({
                id: item.path,
                kind: "正文",
                title: item.name,
                detail: item.path,
                text: item.text,
                matchMode: "text-occurrences"
            }));
            const problems = [...errors].map(([path, error]) => `${path}：${error}`);
            return {
                records, loading: state.loading || running || pending.size > 0 || timer !== undefined,
                error: state.error ?? (problems.length ? problems.join("；") : null),
                progress: {
                    completed: Math.max(0, entries.size - pending.size - (processingPath && !pending.has(processingPath) ? 1 : 0)),
                    total: entries.size
                }
            };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        async open(path, match) {
            const item = items.get(path);
            if (!alive || !item || !match || match.sourceText !== item.text
                || item.text.slice(match.start, match.end) !== match.text) return false;
            const controller = new AbortController();
            opening.add(controller);
            try {
                const latest = await workspace.readSearchText(path, controller.signal);
                if (!alive || controller.signal.aborted || latest === null || items.get(path) !== item) return false;
                const text = await editor.getSearchText(item.name, latest, controller.signal);
                if (!alive || controller.signal.aborted || text !== item.text || items.get(path) !== item) return false;
                if (!await workspace.open(path) || !alive || controller.signal.aborted) return false;
                const document = workspace.getSnapshot().documents.find(candidate => candidate.path === path);
                if (!document || document.content !== latest) return false;
                return editor.revealSearchTarget(sessionId, {
                    documentId: document.id,
                    content: latest,
                    range: {text: item.text, start: match.start, end: match.end},
                });
            } catch {
                return false;
            } finally {
                opening.delete(controller);
            }
        },
        async refresh() {
            if (alive) syncCatalog(true);
        },
    };
    return {
        source, dispose() {
            if (!alive) return;
            alive = false;
            generation++;
            processingController?.abort();
            for (const controller of opening) controller.abort();
            opening.clear();
            if (timer !== undefined) clearTimeout(timer);
            stopCatalog();
            stopWorkspace();
            pending.clear();
            items.clear();
            listeners.clear();
        }
    };
}
