import type {UiLocation, UiNavigationRequest, UiPage, UiPageView, UiSnapshot} from "@lodestory/sdk/ui";

type Listener = () => void;

type PageRegistry = {
    registerPage(page: UiPage): () => void;
    start(initialPage?: string): void;
    previewOpen(id: string, params?: unknown, historyMode?: "push" | "reset"): UiNavigationRequest | null;
    previewBack(): UiNavigationRequest | null;
    commitNavigation(request: UiNavigationRequest): void;
    getSnapshot(): UiSnapshot;
    subscribe(listener: Listener): () => void;
    clear(): void;
};

const emptySnapshot: UiSnapshot = Object.freeze({
    current: null,
    pages: Object.freeze([]),
    canGoBack: false,
});

/** Stores page contributions and navigation state without depending on React at runtime. */
export function createPageRegistry(): PageRegistry {
    const pages = new Map<string, UiPage>();
    const visited = new Set<string>();
    const pageParams = new Map<string, unknown>();
    const history: UiLocation[] = [];
    const listeners = new Set<{listener: Listener}>();
    let current: UiLocation | null = null;
    let snapshot = emptySnapshot;
    let started = false;

    function makeLocation(id: string, params: unknown): UiLocation {
        return Object.freeze({id, params});
    }

    function publish(force = false) {
        const pageViews: UiPageView[] = [];
        for (const id of visited) {
            const page = pages.get(id);
            if (!page) continue;
            pageViews.push(Object.freeze({
                ...page,
                params: pageParams.get(id),
                active: current?.id === id,
            }));
        }

        const next = Object.freeze({
            current,
            pages: Object.freeze(pageViews),
            canGoBack: history.length > 0,
        });
        if (!force && sameSnapshot(snapshot, next)) return;
        snapshot = next;
        for (const subscription of [...listeners]) {
            try {
                subscription.listener();
            } catch (error) {
                // One broken observer must not leave the committed route half-published.
                console.error("UI page listener failed.", error);
            }
        }
    }

    return {
        registerPage(page) {
            if (!page || typeof page !== "object") throw new TypeError("UI page must be an object");
            if (typeof page.id !== "string" || page.id.trim().length === 0) {
                throw new TypeError("UI page id cannot be empty");
            }
            if (typeof page.render !== "function") throw new TypeError("UI page render must be a function");
            if (pages.has(page.id)) throw new Error(`UI page '${page.id}' is already registered`);

            const registered = Object.freeze({id: page.id, render: page.render});
            pages.set(registered.id, registered);
            let disposed = false;
            return () => {
                if (disposed) return;
                disposed = true;
                if (pages.get(registered.id) !== registered) return;

                pages.delete(registered.id);
                visited.delete(registered.id);
                pageParams.delete(registered.id);
                for (let index = history.length - 1; index >= 0; index -= 1) {
                    if (history[index].id === registered.id) history.splice(index, 1);
                }
                if (current?.id === registered.id) current = null;
                publish(true);
            };
        },

        start(initialPage) {
            if (started) throw new Error("UI page registry has already started");
            if (pages.size === 0) throw new Error("Cannot start UI page registry without registered pages");
            const id = initialPage ?? pages.keys().next().value;
            if (!id || !pages.has(id)) throw new Error(`UI page '${id ?? ""}' is not registered`);

            started = true;
            current = makeLocation(id, undefined);
            visited.add(id);
            pageParams.set(id, undefined);
            publish(true);
        },

        previewOpen(id, params, historyMode = "push") {
            if (!started) throw new Error("UI page registry must be started before navigation");
            if (!pages.has(id)) throw new Error(`UI page '${id}' is not registered`);
            if (historyMode !== "push" && historyMode !== "reset") {
                throw new TypeError("UI navigation history must be 'push' or 'reset'.");
            }
            if (current?.id === id && Object.is(current.params, params)
                && (historyMode !== "reset" || history.length === 0)) return null;

            return Object.freeze({
                from: current,
                to: makeLocation(id, params),
                kind: "open" as const,
                ...(historyMode === "reset" ? {history: historyMode} : {}),
            });
        },

        previewBack() {
            if (!started) throw new Error("UI page registry must be started before navigation");
            const previous = history[history.length - 1];
            if (!previous) return null;
            return Object.freeze({from: current, to: previous, kind: "back" as const});
        },

        commitNavigation(request) {
            if (!started) throw new Error("UI page registry must be started before navigation");
            if (request.kind === "open") {
                if (!pages.has(request.to.id)) throw new Error(`UI page '${request.to.id}' is not registered`);
                if (request.history === "reset") history.length = 0;
                else if (current) history.push(current);
                current = request.to;
            } else {
                const previous = history.pop();
                if (!previous || previous !== request.to) throw new Error("UI back target changed before navigation committed");
                current = previous;
            }
            visited.add(request.to.id);
            pageParams.set(request.to.id, request.to.params);
            publish();
        },

        getSnapshot() {
            return snapshot;
        },

        subscribe(listener) {
            if (typeof listener !== "function") throw new TypeError("UI page listener must be a function");
            const subscription = {listener};
            listeners.add(subscription);
            let disposed = false;
            return () => {
                if (disposed) return;
                disposed = true;
                listeners.delete(subscription);
            };
        },

        clear() {
            pages.clear();
            visited.clear();
            pageParams.clear();
            history.length = 0;
            current = null;
            started = false;
            snapshot = emptySnapshot;
            listeners.clear();
        },
    };
}

function sameSnapshot(previous: UiSnapshot, next: UiSnapshot): boolean {
    if (previous.current !== next.current || previous.canGoBack !== next.canGoBack || previous.pages.length !== next.pages.length) {
        return false;
    }
    return previous.pages.every((page, index) => {
        const nextPage = next.pages[index];
        return page.id === nextPage.id && page.render === nextPage.render
            && Object.is(page.params, nextPage.params) && page.active === nextPage.active;
    });
}
