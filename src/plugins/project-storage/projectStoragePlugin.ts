import type {Plugin} from "@lodestory/sdk";
import {projectStorageKey, type ProjectStorageService} from "@lodestory/sdk/project-storage";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {createProjectFiles} from "./createProjectFiles";

type StorageSession = {
    files: ReturnType<typeof createProjectFiles>;
    staged: boolean;
    leaving: boolean;
    disposed: boolean;
    disposal?: Promise<void>;
};

/** Owns byte persistence for project sessions; content encoding and path layout belong to consumers. */
export function createProjectStoragePlugin(): Plugin {
    let cleanup: (() => Promise<void>) | undefined;
    return {
        id: "project-storage", requires: [workbenchKey], provides: [projectStorageKey],
        activate(context) {
            const workbench = context.get(workbenchKey);
            const sessions = new Map<string, StorageSession>();
            let alive = true;

            function canMutate(id: string, session: StorageSession | undefined) {
                const state = workbench.getSnapshot();
                return alive && !!session && !session.disposed && !session.leaving && !state.busy && state.session?.id === id;
            }

            function canLoad(id: string, session: StorageSession | undefined) {
                const state = workbench.getSnapshot();
                return alive && !!session && !session.disposed && !session.leaving
                    && (session.staged || !state.busy && state.session?.id === id);
            }

            const service: ProjectStorageService = Object.freeze({
                getFiles(id: string) {
                    const session = sessions.get(id);
                    return alive && session && !session.disposed && !session.leaving ? session.files.service : null;
                },
            });
            context.provide(projectStorageKey, service);
            const unsubscribe = workbench.subscribe(() => {
                const state = workbench.getSnapshot();
                for (const [id, session] of sessions) {
                    if (state.session?.id === id) session.staged = false;
                    session.files.refreshBlocked();
                }
            });
            let removeParticipant: (() => Promise<void>) | undefined;
            cleanup = async () => {
                alive = false;
                unsubscribe();
                await removeParticipant?.();
                sessions.clear();
            };
            removeParticipant = workbench.registerParticipant({
                id: "project-storage",
                start(session) {
                    if (!alive || sessions.has(session.id)) throw new Error(`Project storage session '${session.id}' cannot be started.`);
                    let managed!: StorageSession;
                    const files = createProjectFiles(session.project.path, {
                        canMutate: () => canMutate(session.id, managed), canLoad: () => canLoad(session.id, managed),
                    });
                    managed = {files, staged: true, leaving: false, disposed: false};
                    sessions.set(session.id, managed);
                    return {
                        async beforeLeave() {
                            if (managed.disposed) return true;
                            managed.leaving = true;
                            files.refreshBlocked();
                            const saving = files.beginLeave();
                            try {
                                return await saving;
                            } finally {
                                files.endLeave();
                                managed.leaving = false;
                                files.refreshBlocked();
                            }
                        },
                        dispose() {
                            if (managed.disposal) return managed.disposal;
                            let complete!: () => void;
                            let reject!: (cause: unknown) => void;
                            managed.disposal = new Promise<void>((done, fail) => {
                                complete = done;
                                reject = fail;
                            });
                            managed.disposed = true;
                            files.refreshBlocked();
                            void files.dispose().then(() => {
                                if (sessions.get(session.id) === managed) sessions.delete(session.id);
                                complete();
                            }, reject);
                            return managed.disposal;
                        },
                    };
                },
            });
        },
        async deactivate() {
            const stop = cleanup;
            cleanup = undefined;
            await stop?.();
        },
    };
}
