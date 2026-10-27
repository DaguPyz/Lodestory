import type {DocumentSnapshot, DocumentWorkspace, OpenDocument} from "@lodestory/sdk/documents";
import type {DocumentTextFile, DocumentTextFiles} from "./documentFiles";

type Options = {
    canMutate?: () => boolean;
    onReveal?: (documentId: string) => void;
};

type CachedDocument = { file: DocumentTextFile; document: OpenDocument };

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message
    : typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string" ? cause.message
        : typeof cause === "string" ? cause : "文档操作失败，请重试。";

/** Tracks open-tab membership and selection; project storage owns file buffers and persistence. */
export function createDocumentWorkspace(files: DocumentTextFiles, options: Options = {}) {
    const listeners = new Set<() => void>();
    const pending = new Set<Promise<unknown>>();
    const closing = new Map<string, Promise<boolean>>();
    const openPaths: string[] = [];
    const membershipTokens = new Map<string, object>();
    const contentReaders = new Map<string, {token: symbol; reader: (currentContent: string) => string}>();
    const cached = new Map<string, CachedDocument>();
    const canMutate = options.canMutate ?? (() => true);
    let activeId: string | null = null;
    let openingPath: string | null = null;
    let creating = false;
    let deletingPath: string | null = null;
    let localError: string | null = null;
    let selection = 0;
    let checkingLeave = false;
    let disposed = false;
    let disposal: Promise<void> | undefined;
    let removedActiveId: string | null = null;
    let snapshot: DocumentSnapshot = Object.freeze({
        documents: Object.freeze([]), activeId, openingPath, creating, deletingPath,
        blocked: !canMutate() || files.getSnapshot().blocked, error: null,
    });

    const currentError = () => localError;
    const operationError = (cause: unknown) => errorMessage(cause);

    function blocked() {
        return disposed || checkingLeave || !canMutate() || files.getSnapshot().blocked;
    }

    function invokeStore<T>(start: () => Promise<T>): Promise<T> {
        try {
            return Promise.resolve(start());
        } catch (cause) {
            return Promise.reject(cause);
        }
    }

    function notify() {
        for (const listener of [...listeners]) {
            if (!listeners.has(listener)) continue;
            try {
                listener();
            } catch (cause) {
                console.error("Document subscriber failed.", {error: cause});
            }
        }
    }

    function documentFor(file: DocumentTextFile): OpenDocument {
        const id = encodeURIComponent(file.path);
        const previous = cached.get(id);
        if (previous?.file === file) return previous.document;
        const document = Object.freeze({
            id, path: file.path, fileName: file.fileName, content: file.content,
            saveState: file.saveState, saveError: file.saveError,
        });
        cached.set(id, {file, document});
        return document;
    }

    function pruneMissingFiles() {
        const available = new Set(files.getSnapshot().files.map(file => file.path));
        const previousPaths = [...openPaths];
        const previousActive = activeId;
        for (let index = openPaths.length - 1; index >= 0; index -= 1) {
            const path = openPaths[index];
            if (available.has(path)) continue;
            const id = encodeURIComponent(path);
            openPaths.splice(index, 1);
            membershipTokens.delete(id);
            contentReaders.delete(id);
            cached.delete(id);
        }
        if (previousActive && !openPaths.some(path => encodeURIComponent(path) === previousActive)) {
            const oldIndex = previousPaths.findIndex(path => encodeURIComponent(path) === previousActive);
            const candidates = [...previousPaths.slice(0, Math.max(0, oldIndex)).reverse(), ...previousPaths.slice(oldIndex + 1)];
            const fallback = candidates.find(path => openPaths.includes(path));
            activeId = fallback ? encodeURIComponent(fallback) : null;
            removedActiveId = activeId;
        }
    }

    function publish() {
        if (disposed) return;
        pruneMissingFiles();
        const fileByPath = new Map(files.getSnapshot().files.map(file => [file.path, file]));
        const nextDocuments = openPaths.flatMap(path => {
            const file = fileByPath.get(path);
            return file ? [documentFor(file)] : [];
        });
        const previous = snapshot.documents;
        const documents = previous.length === nextDocuments.length && previous.every((value, index) => value === nextDocuments[index])
            ? previous : Object.freeze(nextDocuments);
        const isBlocked = blocked();
        const nextError = currentError();
        if (snapshot.documents === documents && snapshot.activeId === activeId && snapshot.openingPath === openingPath
            && snapshot.creating === creating && snapshot.deletingPath === deletingPath
            && snapshot.blocked === isBlocked && snapshot.error === nextError) return;
        const previousById = new Map(previous.map(document => [document.id, document]));
        snapshot = Object.freeze({
            documents,
            activeId,
            openingPath,
            creating,
            deletingPath,
            blocked: isBlocked,
            error: nextError
        });
        notify();
        if (removedActiveId) {
            const revealId = removedActiveId;
            removedActiveId = null;
            reveal(revealId);
        }
        for (const document of documents) {
            const before = previousById.get(document.id);
            if (document.saveState === "error" && before?.saveState !== "error") {
                if (!flushBeforeActivation(document.id)) break;
                selection += 1;
                activeId = document.id;
                openingPath = null;
                // Persist the new active tab before requesting the host to show it.
                publish();
                reveal(document.id);
                break;
            }
        }
    }

    function reveal(id: string) {
        if (disposed) return;
        try {
            options.onReveal?.(id);
        } catch (cause) {
            console.error("Document presentation request failed.", {error: cause});
        }
    }

    function activate(id: string, requestReveal = true, outgoingFlushed = false) {
        if (!outgoingFlushed && !flushBeforeActivation(id)) return false;
        activeId = id;
        openingPath = null;
        publish();
        if (requestReveal) reveal(id);
        return true;
    }

    // Store calls begin synchronously after local locks are installed, before publishing can make the workbench busy.
    function run<T>(start: () => Promise<T>, prepare?: () => void): Promise<T> {
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (cause: unknown) => void;
        const operation = new Promise<T>((done, fail) => {
            resolve = done;
            reject = fail;
        });
        pending.add(operation);
        void operation.then(() => pending.delete(operation), () => pending.delete(operation));
        try {
            prepare?.();
            const result = start();
            publish();
            void Promise.resolve(result).then(resolve, reject);
        } catch (cause) {
            publish();
            reject(cause);
        }
        return operation;
    }

    async function drain() {
        const errors: unknown[] = [];
        while (pending.size) {
            for (const result of await Promise.allSettled([...pending])) {
                if (result.status === "rejected") errors.push(result.reason);
            }
        }
        if (errors.length) throw Object.assign(new Error("Document operations could not finish."), {errors});
    }

    function validPath(path: string, allowRoot = false) {
        return typeof path === "string" && (allowRoot && path === "" || path.length > 0 && !/[\\:\u0000-\u001f]/.test(path)
            && path.split("/").every(part => part !== "" && part !== "." && part !== ".."));
    }

    function validDocumentName(name: string) {
        return typeof name === "string" && !!name.trim() && !/[\\/\u0000-\u001f]/.test(name);
    }

    function completeDocumentName(name: string) {
        return /\.(?:md|markdown|txt|lode)$/i.test(name) ? name : `${name}.md`;
    }

    function install(file: DocumentTextFile, publishChanges = true) {
        if (!openPaths.includes(file.path)) {
            openPaths.push(file.path);
            membershipTokens.set(encodeURIComponent(file.path), {});
        }
        const document = documentFor(file);
        if (publishChanges) publish();
        return document;
    }

    /** Synchronously copies the mounted editor's latest text into the existing shared buffer. */
    function flushContentReader(id: string): boolean {
        const registered = contentReaders.get(id);
        if (!registered) return true;
        const document = snapshot.documents.find(item => item.id === id);
        const file = document && files.getSnapshot().files.find(item => item.path === document.path);
        if (!document || !file) {
            localError = "文档已关闭，无法读取最新正文。";
            return false;
        }
        let content: string;
        try {
            content = registered.reader(file.content);
        } catch (cause) {
            localError = operationError(cause);
            return false;
        }
        if (typeof content !== "string") {
            localError = "无法读取最新正文：正文读取器未返回文本。";
            return false;
        }
        const latest = files.getSnapshot().files.find(item => item.path === document.path);
        if (content !== latest?.content && !files.update(document.path, content)) {
            localError = files.getSnapshot().error ?? "无法更新文档正文缓冲。";
            return false;
        }
        localError = null;
        return true;
    }

    function flushOpenContentReaders(): boolean {
        for (const path of [...openPaths]) {
            if (!flushContentReader(encodeURIComponent(path))) return false;
        }
        return true;
    }

    function flushBeforeActivation(id: string): boolean {
        while (activeId && activeId !== id) {
            const currentId = activeId;
            if (!flushContentReader(currentId)) {
                publish();
                return false;
            }
            // Updating the shared buffer may publish a save-state transition and change the
            // active tab; flush that tab too before switching away from it.
            if (activeId === currentId) return true;
        }
        return true;
    }

    async function saveOpenDocuments() {
        if (!flushOpenContentReaders()) return false;
        for (const path of [...openPaths]) {
            const id = encodeURIComponent(path);
            if (!files.getSnapshot().files.some(file => file.path === path)) continue;
            let saved = false;
            let failure: unknown;
            try {
                saved = await invokeStore(() => files.save(path));
            } catch (cause) {
                failure = cause;
            }
            if (saved) continue;
            const file = files.getSnapshot().files.find(item => item.path === path);
            localError = file?.saveError ?? files.getSnapshot().error ?? (failure === undefined ? null : errorMessage(failure));
            if (!disposed && membershipTokens.has(id) && activeId !== id) activate(id);
            return false;
        }
        return true;
    }

    const unsubscribeFiles = files.subscribe(publish);
    const service: DocumentWorkspace = Object.freeze({
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
            if (disposed) return () => {
            };
            const subscription = () => listener();
            listeners.add(subscription);
            return () => {
                listeners.delete(subscription);
            };
        },
        open(path: string) {
            if (blocked()) return Promise.resolve(false);
            if (!validPath(path)) {
                localError = "文档路径必须位于项目目录内。";
                publish();
                return Promise.resolve(false);
            }
            if (deletingPath === path) return Promise.resolve(false);
            const id = encodeURIComponent(path);
            if (closing.has(id)) return Promise.resolve(false);
            const sequence = ++selection;
            localError = null;
            if (openPaths.includes(path)) {
                return Promise.resolve(activate(id));
            }
            return run(() => invokeStore(() => files.open(path)).then(file => {
                if (!file) {
                    localError = files.getSnapshot().error;
                    publish();
                    return false;
                }
                if (disposed || sequence !== selection) return false;
                if (!flushBeforeActivation(id)) return false;
                install(file, false);
                return !disposed && activate(id, true, true);
            }).catch(cause => {
                if (!disposed && sequence === selection) {
                    localError = operationError(cause);
                    publish();
                }
                return false;
            }).finally(() => {
                if (!disposed && sequence === selection) {
                    openingPath = null;
                    publish();
                }
            }), () => {
                openingPath = path;
            });
        },
        create(parentPath: string, name: string) {
            if (blocked() || creating) return Promise.resolve(null);
            if (!validPath(parentPath, true) || !validDocumentName(name)) {
                localError = "文档名称和目录无效。";
                publish();
                return Promise.resolve(null);
            }
            const sequence = ++selection;
            const completeName = completeDocumentName(name);
            return run(() => invokeStore(() => files.create(parentPath, completeName)).then(file => {
                if (!file) {
                    localError = files.getSnapshot().error;
                    publish();
                    return null;
                }
                if (disposed) return null;
                const document = install(file);
                if (sequence === selection) activate(document.id);
                return disposed ? null : document;
            }).catch(cause => {
                if (!disposed) {
                    localError = operationError(cause);
                    publish();
                }
                return null;
            }).finally(() => {
                creating = false;
                publish();
            }), () => {
                creating = true;
                openingPath = null;
                localError = null;
            });
        },
        createDirectory(parentPath: string, name: string) {
            if (blocked() || creating || deletingPath !== null) return Promise.resolve(null);
            if (!validPath(parentPath, true) || typeof name !== "string" || !name.trim()
                || name !== name.trim() || /[\\/:\u0000-\u001f]/.test(name) || name === "." || name === "..") {
                localError = "目录名称和位置无效。";
                publish();
                return Promise.resolve(null);
            }
            return run(() => invokeStore(() => files.createDirectory(parentPath, name)).then(path => {
                if (path === null) localError = files.getSnapshot().error;
                return path ?? null;
            }).catch(cause => {
                if (!disposed) {
                    localError = operationError(cause);
                    publish();
                }
                return null;
            }).finally(() => {
                creating = false;
                publish();
            }), () => {
                creating = true;
                localError = null;
            });
        },
        saveAs(documentId: string, fileName: string, content: string) {
            if (blocked() || creating) return Promise.reject(new Error("当前不能另存文档。"));
            const source = snapshot.documents.find(document => document.id === documentId);
            if (!source || closing.has(documentId) || deletingPath === source.path) {
                return Promise.reject(new Error("源文档已关闭或正在删除。"));
            }
            if (typeof content !== "string" || typeof fileName !== "string" || !fileName.trim()
                || fileName !== fileName.trim() || fileName.startsWith(".") || /[\\/:\u0000-\u001f]/.test(fileName)
                || !/\.(md|markdown|txt|lode)$/i.test(fileName)) {
                return Promise.reject(new Error("另存文件名或内容无效。"));
            }
            if (!flushContentReader(documentId)) {
                publish();
                return Promise.reject(new Error(localError ?? "无法读取最新正文。"));
            }
            const parentPath = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : "";
            if (!validPath(parentPath, true)) return Promise.reject(new Error("源文档目录无效。"));
            const targetPath = parentPath ? `${parentPath}/${fileName}` : fileName;
            if (openPaths.includes(targetPath)) return Promise.reject(new Error("同名文档已在工作区打开。"));
            const sequence = ++selection;
            return run(() => invokeStore(() => files.create(parentPath, fileName, content)).then(file => {
                if (!file) throw new Error(files.getSnapshot().error ?? "另存文档失败。");
                if (disposed) return;
                const sourceStillOpen = snapshot.documents.some(document => document.id === documentId);
                const document = install(file);
                if (sourceStillOpen && sequence === selection) activate(document.id);
            }).catch(cause => {
                if (!disposed) {
                    localError = operationError(cause);
                    publish();
                }
                throw cause;
            }).finally(() => {
                creating = false;
                publish();
            }), () => {
                creating = true;
                openingPath = null;
                localError = null;
            });
        },
        select(id: string) {
            if (blocked() || closing.has(id) || !snapshot.documents.some(document => document.id === id)) return false;
            if (!flushBeforeActivation(id)) return false;
            selection += 1;
            return activate(id, true, true);
        },
        update(id: string, content: string) {
            if (blocked() || closing.has(id) || typeof content !== "string") return false;
            const document = snapshot.documents.find(item => item.id === id);
            if (!document || deletingPath === document.path) return false;
            const updated = files.update(document.path, content);
            if (updated) publish();
            return updated;
        },
        registerContentReader(documentId: string, reader: (currentContent: string) => string) {
            if (disposed || !snapshot.documents.some(document => document.id === documentId)) {
                throw new Error("只能为已打开的文档注册正文读取器。");
            }
            if (typeof reader !== "function") throw new TypeError("正文读取器必须是函数。");
            const token = Symbol(documentId);
            contentReaders.set(documentId, {token, reader});
            return () => {
                if (contentReaders.get(documentId)?.token === token) contentReaders.delete(documentId);
            };
        },
        deleteDocument(path: string, options: { discardChanges?: boolean } = {}) {
            if (blocked() || deletingPath !== null || creating) return Promise.resolve(false);
            if (!validPath(path)) {
                localError = "文档路径必须位于项目目录内。";
                publish();
                return Promise.resolve(false);
            }
            if (openingPath === path) return Promise.resolve(false);
            const id = encodeURIComponent(path);
            if (closing.has(id) || (options.discardChanges !== undefined && typeof options.discardChanges !== "boolean")) return Promise.resolve(false);
            if (options.discardChanges !== true && !flushContentReader(id)) {
                publish();
                return Promise.resolve(false);
            }
            const before = [...openPaths];
            return run(() => invokeStore(() => files.delete(path, options)).then(deleted => {
                if (!deleted) {
                    const file = files.getSnapshot().files.find(item => item.path === path);
                    localError = files.getSnapshot().error
                        ?? (file?.dirty && options.discardChanges !== true ? "文档有未保存修改；确认后才能删除。" : null);
                    publish();
                    return false;
                }
                localError = null;
                const index = before.indexOf(path);
                const wasActive = activeId === id;
                const stillOpen = snapshot.documents.some(document => document.id === id);
                if (stillOpen) {
                    openPaths.splice(openPaths.indexOf(path), 1);
                    membershipTokens.delete(id);
                    contentReaders.delete(id);
                    cached.delete(id);
                }
                if (wasActive) {
                    const fallbackIndex = Math.min(Math.max(0, index - 1), openPaths.length - 1);
                    activeId = fallbackIndex >= 0 ? encodeURIComponent(openPaths[fallbackIndex]) : null;
                    if (activeId) reveal(activeId);
                }
                publish();
                return true;
            }).catch(cause => {
                if (!disposed) {
                    localError = operationError(cause);
                    publish();
                }
                return false;
            }).finally(() => {
                deletingPath = null;
                publish();
            }), () => {
                deletingPath = path;
                localError = null;
            });
        },
        close(id: string) {
            if (blocked()) return Promise.resolve(false);
            const document = snapshot.documents.find(item => item.id === id);
            if (deletingPath !== null && document?.path === deletingPath) return Promise.resolve(false);
            const existing = closing.get(id);
            if (existing) return existing;
            if (!document) return Promise.resolve(true);
            const token = membershipTokens.get(id);
            if (!token) return Promise.resolve(false);
            if (!flushContentReader(id)) {
                publish();
                return Promise.resolve(false);
            }
            let finish!: (value: boolean) => void;
            let fail!: (cause: unknown) => void;
            const promise = new Promise<boolean>((resolve, reject) => {
                finish = resolve;
                fail = reject;
            });
            closing.set(id, promise);
            const operation = run(() => invokeStore(() => files.save(document.path)).then(saved => {
                if (!saved) {
                    localError = files.getSnapshot().files.find(file => file.path === document.path)?.saveError
                        ?? files.getSnapshot().error;
                    if (membershipTokens.get(id) === token && activeId !== id) activate(id);
                    return false;
                }
                if (disposed || membershipTokens.get(id) !== token || !openPaths.includes(document.path)) return false;
                const index = openPaths.indexOf(document.path);
                openPaths.splice(index, 1);
                membershipTokens.delete(id);
                contentReaders.delete(id);
                cached.delete(id);
                if (activeId === id) activeId = openPaths[Math.max(0, index - 1)] ? encodeURIComponent(openPaths[Math.max(0, index - 1)]) : null;
                publish();
                return true;
            }), () => {
                localError = null;
            });
            void operation.then(value => {
                if (closing.get(id) === promise) closing.delete(id);
                finish(value);
            }, cause => {
                if (closing.get(id) === promise) closing.delete(id);
                fail(cause);
            });
            return promise;
        },
        closeMany(ids: readonly string[]) {
            if (blocked()) return Promise.resolve(false);
            const targets = [...new Set(ids)].map(id => ({
                id,
                token: membershipTokens.get(id)
            })).filter(target => target.token);
            return run(async () => {
                for (const {id, token} of targets) {
                    if (blocked()) return false;
                    if (membershipTokens.get(id) !== token) continue;
                    if (!await service.close(id)) return false;
                }
                return true;
            });
        },
        save(id: string) {
            if (disposed) return Promise.resolve(false);
            const document = snapshot.documents.find(item => item.id === id);
            if (document && deletingPath !== document.path) {
                if (!flushContentReader(id)) {
                    publish();
                    return Promise.resolve(false);
                }
                return run(() => invokeStore(() => files.save(document.path)).then(saved => {
                    if (!saved && !disposed) {
                        localError = files.getSnapshot().files.find(file => file.path === document.path)?.saveError ?? files.getSnapshot().error;
                        if (activeId !== id) activate(id);
                    }
                    return saved;
                }), () => {
                    localError = null;
                });
            }
            return Promise.resolve(false);
        },
        saveAll() {
            if (disposed) return Promise.resolve(false);
            return run(() => saveOpenDocuments(), () => {
                localError = null;
            });
        },
        clearError() {
            if (disposed) return;
            localError = null;
            files.clearError();
            publish();
        },
    });

    return {
        service,
        refreshBlocked: publish,
        async beforeLeave() {
            if (disposed) return true;
            if (checkingLeave) return false;
            if (!flushOpenContentReaders()) {
                publish();
                return false;
            }
            checkingLeave = true;
            publish();
            try {
                await drain();
                return disposed ? true : await service.saveAll();
            } finally {
                checkingLeave = false;
                publish();
            }
        },
        dispose(): Promise<void> {
            if (disposal) return disposal;
            let complete!: () => void;
            let fail!: (cause: unknown) => void;
            disposal = new Promise<void>((done, reject) => {
                complete = done;
                fail = reject;
            });
            const contentFlushed = flushOpenContentReaders();
            const readerError = localError;
            contentReaders.clear();
            disposed = true;
            selection += 1;
            snapshot = Object.freeze({
                documents: Object.freeze([]), activeId: null, openingPath: null,
                creating: false, deletingPath: null, blocked: true, error: null
            });
            notify();
            listeners.clear();
            let operationFailure: unknown;
            void drain().catch(cause => {
                operationFailure = cause;
            }).then(async () => {
                let saved = false;
                if (contentFlushed) {
                    try {
                        saved = await saveOpenDocuments();
                    } catch (cause) {
                        operationFailure ??= cause;
                    }
                } else {
                    operationFailure ??= new Error(readerError ?? "无法读取最新正文。");
                }
                unsubscribeFiles();
                if (operationFailure !== undefined || !saved) {
                    const available = new Map(files.getSnapshot().files.map(file => [file.path, file]));
                    const recoverable = openPaths.flatMap(path => {
                        const file = available.get(path);
                        return file ? [documentFor(file)] : [];
                    });
                    snapshot = Object.freeze({
                        documents: Object.freeze(recoverable),
                        activeId: recoverable.some(document => document.id === activeId) ? activeId : null,
                        openingPath: null, creating: false, deletingPath: null, blocked: true,
                        error: files.getSnapshot().error ?? readerError ?? "停止时有文档未能保存，草稿已保留。"
                    });
                    const failure = new Error("Documents could not be saved while stopping the workspace.");
                    Object.defineProperty(failure, "snapshot", {value: snapshot});
                    files.dispose?.();
                    throw failure;
                }
                unsubscribeFiles();
                files.dispose?.();
                openPaths.splice(0);
                membershipTokens.clear();
                cached.clear();
            }).then(complete, fail);
            return disposal;
        },
    };
}
