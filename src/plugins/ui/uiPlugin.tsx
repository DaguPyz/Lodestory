import {StrictMode, type ReactNode} from "react";
import {createRoot, type Root, type RootOptions} from "react-dom/client";
import {flushSync} from "react-dom";
import type {Plugin} from "@lodestory/sdk";
import {pluginsReady} from "../../plugin-core";
import {configKey} from "@lodestory/sdk/config";
import {uiInitialPageConfig, uiMotionConfig, uiKey, UiNavigationCompleteError, type UiNavigationApproval, type UiNavigationGuard, type UiNavigationRequest, type UiService, type UiWrapper} from "@lodestory/sdk/ui";
import {errorUiKey} from "@lodestory/sdk/error";
import {createPageRegistry} from "./pageRegistry";
import {UiPages} from "./UiPages";

const motionAttributeOwners = new WeakMap<Element, symbol>();

function ownMotionAttribute(root: Element, initialValue: "system" | "reduce") {
    if (motionAttributeOwners.has(root)) {
        throw new Error("The UI motion preference is already owned for this document root.");
    }
    const owner = Symbol("ui-motion");
    const previousValue = root.getAttribute("data-ui-motion");
    motionAttributeOwners.set(root, owner);

    function apply(value: "system" | "reduce") {
        if (motionAttributeOwners.get(root) !== owner) return;
        if (value === "reduce") root.setAttribute("data-ui-motion", "reduce");
        else root.removeAttribute("data-ui-motion");
    }

    try {
        apply(initialValue);
    } catch (error) {
        motionAttributeOwners.delete(root);
        throw error;
    }

    return {
        set: apply,
        restore() {
            if (motionAttributeOwners.get(root) !== owner) return;
            try {
                if (previousValue === null) root.removeAttribute("data-ui-motion");
                else root.setAttribute("data-ui-motion", previousValue);
            } finally {
                motionAttributeOwners.delete(root);
            }
        },
    };
}

export type UiPluginOptions = {
    readonly rootOptions?: RootOptions;
};

/**
 * 合并页面管理与根装配；只认识页面登记和包装规则，不导入具体业务组件。
 * ready 时选择初始页面并挂载通用页面容器，之后由页面状态驱动 React 更新。
 */
export function createUiPlugin(container?: Element | DocumentFragment, options: UiPluginOptions = {}): Plugin {
    const {rootOptions} = options;
    let cleanup: (() => void) | undefined;

    return {
        id: "ui",
        requires: [errorUiKey, configKey],
        provides: [uiKey],

        activate(context) {
            const {ErrorBoundary} = context.get(errorUiKey);
            const config = context.get(configKey);
            const removeInitialPageConfig = config.register(uiInitialPageConfig);
            let removeMotionConfig: (() => void) | undefined;
            let unsubscribeMotionConfig: (() => void) | undefined;
            let restoreMotionAttribute: (() => void) | undefined;
            try {
                removeMotionConfig = config.register(uiMotionConfig);
                const motionRoot = typeof document === "undefined" ? undefined : document.documentElement;
                if (motionRoot) {
                    const motionAttribute = ownMotionAttribute(motionRoot, config.getSnapshot(uiMotionConfig));
                    restoreMotionAttribute = () => motionAttribute.restore();
                    unsubscribeMotionConfig = config.subscribe(uiMotionConfig, () => {
                        motionAttribute.set(config.getSnapshot(uiMotionConfig));
                    });
                }
            } catch (error) {
                try {
                    unsubscribeMotionConfig?.();
                } finally {
                    try {
                        removeMotionConfig?.();
                    } finally {
                        try {
                            removeInitialPageConfig();
                        } finally {
                            restoreMotionAttribute?.();
                        }
                    }
                }
                throw error;
            }
            // 每次激活使用独立登记和状态，旧服务和旧撤销函数不能影响下一次激活。
            const pages = createPageRegistry();
            const pageOwners = new Map<string, symbol>();
            const wrappers = new Map<string, UiWrapper>();
            const navigationGuards = new Map<string, UiNavigationGuard>();
            const overlays = new Set<{element: HTMLElement}>();
            let active = true;
            let mountAttempted = false;
            let navigationAllowed = false;
            let navigationInFlight = false;
            let navigationGeneration = 0;
            let reactRoot: Root | undefined;
            let renderFailureHandled = false;
            let firstRenderError: unknown;
            let rootFallbackRenderAttempted = false;
            let rootFallbackFailureReported = false;

            function unmount() {
                const root = reactRoot;
                root?.unmount();
                navigationAllowed = false;
                navigationGeneration += 1;
                reactRoot = undefined;
                overlays.clear();
            }

            context.onStop({
                withdrawOrder: -999,
                check(scope) {
                    if (scope === "plugin" && reactRoot) throw new Error("The UI root cannot be stopped while the application is running.");
                },
                withdraw(scope) {
                    if (scope === "application") unmount();
                },
            });

            cleanup = () => {
                active = false;
                try {
                    unmount();
                } finally {
                    try {
                        pages.clear();
                        pageOwners.clear();
                        wrappers.clear();
                        navigationGuards.clear();
                    } finally {
                        try {
                            unsubscribeMotionConfig?.();
                        } finally {
                            try {
                                removeMotionConfig?.();
                            } finally {
                                try {
                                    removeInitialPageConfig();
                                } finally {
                                    restoreMotionAttribute?.();
                                }
                            }
                        }
                    }
                }
            };

            function checkActive() {
                if (!active) throw new Error("UI service is no longer active.");
            }

            function checkRegistrationAllowed() {
                checkActive();
                if (mountAttempted) throw new Error("UI contributions must be registered before pluginsReady.");
            }

            function checkNavigationAllowed() {
                checkActive();
                if (!navigationAllowed) throw new Error("UI navigation requires a mounted page container after pluginsReady.");
            }

            async function cancelApprovals(approvals: readonly UiNavigationApproval[]) {
                for (let index = approvals.length - 1; index >= 0; index -= 1) {
                    if (!approvals[index].cancel) continue;
                    let cancellation: void | Promise<void> = undefined;
                    try {
                        flushSync(() => {
                            cancellation = approvals[index].cancel?.();
                        });
                    } catch (error) {
                        console.error("UI navigation guard rollback failed.", {error});
                    }
                    try {
                        await cancellation;
                    } catch (error) {
                        console.error("UI navigation guard cancellation failed.", {error});
                    }
                }
            }

            function navigationStillValid(generation: number, guards: readonly UiNavigationGuard[]) {
                return active && navigationAllowed && navigationGeneration === generation
                    && guards.every(guard => navigationGuards.get(guard.id) === guard);
            }

            async function navigate(request: UiNavigationRequest | null): Promise<boolean> {
                if (navigationInFlight) return false;
                if (!request) return true;

                navigationInFlight = true;
                const generation = navigationGeneration;
                const guardSnapshot = [...navigationGuards.values()];
                const approvals: UiNavigationApproval[] = [];

                try {
                    for (const guard of guardSnapshot) {
                        let result: boolean | UiNavigationApproval;
                        try {
                            result = await guard.prepare(request);
                        } catch (error) {
                            console.error("UI navigation guard failed.", {guardId: guard.id, error});
                            await cancelApprovals(approvals);
                            throw error;
                        }

                        const approval = result !== null && typeof result === "object" ? result : undefined;
                        if (approval) approvals.push(approval);

                        // A disposer or UI shutdown during an awaited guard invalidates this route.
                        // Include a late approval above so its prepared resources are also released.
                        if (!navigationStillValid(generation, guardSnapshot)) {
                            await cancelApprovals(approvals);
                            return false;
                        }
                        if (result !== true && !approval) {
                            await cancelApprovals(approvals);
                            if (result === false) return false;
                            throw new TypeError(`UI navigation guard '${guard.id}' must return true, false, or an approval.`);
                        }
                    }

                    if (!navigationStillValid(generation, guardSnapshot)) {
                        await cancelApprovals(approvals);
                        return false;
                    }

                    let commitFailure: unknown;
                    let commitFailed = false;
                    let invalidatedDuringCommit = false;
                    let routeCommitted = false;
                    const completionErrors: unknown[] = [];
                    try {
                        // Commit guard state and publish the route together. Workbench complete
                        // hooks may dispose the old session only after React processed this tree.
                        flushSync(() => {
                            for (let index = 0; index < approvals.length; index += 1) {
                                if (!navigationStillValid(generation, guardSnapshot)) {
                                    invalidatedDuringCommit = true;
                                    break;
                                }
                                try {
                                    approvals[index].commit?.();
                                } catch (error) {
                                    commitFailure = error;
                                    commitFailed = true;
                                    break;
                                }
                            }
                            if (commitFailed || invalidatedDuringCommit) return;
                            if (!navigationStillValid(generation, guardSnapshot)) {
                                invalidatedDuringCommit = true;
                                return;
                            }
                            try {
                                pages.commitNavigation(request);
                                routeCommitted = true;
                            } catch (error) {
                                commitFailure = error;
                                commitFailed = true;
                            }
                        });
                    } catch (error) {
                        if (routeCommitted) completionErrors.push(error);
                        else {
                            if (!commitFailed) commitFailure = error;
                            commitFailed = true;
                        }
                    }
                    if (invalidatedDuringCommit) {
                        await cancelApprovals(approvals);
                        return false;
                    }
                    if (commitFailed) {
                        console.error("UI navigation commit failed.", {error: commitFailure});
                        await cancelApprovals(approvals);
                        throw commitFailure;
                    }

                    for (const approval of approvals) {
                        try {
                            await approval.complete?.();
                        } catch (error) {
                            completionErrors.push(error);
                        }
                    }
                    if (completionErrors.length > 0) throw new UiNavigationCompleteError(completionErrors);
                    return true;
                } finally {
                    navigationInFlight = false;
                }
            }

            function recoverFromRenderError(error: unknown) {
                const root = reactRoot;
                if (!active || !root || renderFailureHandled) return;

                // Keep the root and all plugin services alive, but prevent route actions from
                // claiming the failed page tree is still mounted while recovery is pending.
                renderFailureHandled = true;
                firstRenderError = error;
                navigationAllowed = false;
                console.error("UI rendering failed.", {error});

                void Promise.resolve().then(() => {
                    // A queued callback must never recreate UI after deactivation or contribution removal.
                    if (!active || reactRoot !== root) return;
                    rootFallbackRenderAttempted = true;
                    try {
                        root.render(<StrictMode><RootRenderFallback/></StrictMode>);
                    } catch (fallbackError) {
                        reportRootFallbackFailure(fallbackError);
                    }
                });
            }

            function reportRootFallbackFailure(fallbackError: unknown) {
                if (rootFallbackFailureReported) return;
                rootFallbackFailureReported = true;
                // The root-level fallback is terminal: never call the same failing view again.
                console.error("UI root fallback rendering failed.", {renderError: firstRenderError, fallbackError});
            }

            function handleUncaughtError(error: unknown, errorInfo: Parameters<NonNullable<RootOptions["onUncaughtError"]>>[1]) {
                if (!active || !reactRoot) return;
                if (rootFallbackRenderAttempted) reportRootFallbackFailure(error);
                else recoverFromRenderError(error);
                try {
                    rootOptions?.onUncaughtError?.(error, errorInfo);
                } catch (observerError) {
                    // The caller's hook observes the failure; its own exception must not fail startup.
                    console.error("UI render error observer failed.", {error: observerError});
                }
            }

            const service: UiService = {
                registerOverlay(element) {
                    checkActive();
                    const registration = {element};
                    overlays.add(registration);
                    return () => { overlays.delete(registration); };
                },
                hasActiveOverlay() {
                    checkActive();
                    for (const {element} of overlays) {
                        if (!element.isConnected || element.closest("[hidden], [inert]") || !element.getClientRects().length) continue;
                        const view = element.ownerDocument.defaultView;
                        if (view?.getComputedStyle(element).visibility === "visible") return true;
                    }
                    return false;
                },
                registerPage(page) {
                    checkActive();
                    if (mountAttempted && !navigationAllowed) throw new Error("UI pages cannot be registered before pluginsReady completes.");
                    const remove = pages.registerPage(page);
                    const pageId = page.id;
                    let registered = true;
                    let owner: symbol | undefined;
                    const alternative = () => pages.alternative(pageId, candidate => owner === undefined || pageOwners.get(candidate) !== owner);

                    async function leave() {
                        if (!registered || pages.getSnapshot().current?.id !== pageId) return;
                        const target = alternative();
                        if (!target) throw new Error(`Cannot remove the last active page '${pageId}'.`);
                        const back = pages.previewBack();
                        const request = back?.to === target ? back : pages.previewOpen(target.id, target.params);
                        if (!await navigate(request)) throw new Error(`离开页面 ${pageId} 的操作被取消。`);
                    }

                    const dispose = () => {
                        if (!registered) return;
                        if (reactRoot && pages.getSnapshot().current?.id === pageId) {
                            throw new Error(`Active page '${pageId}' must be withdrawn through the plugin lifecycle.`);
                        }
                        if (reactRoot) flushSync(() => remove());
                        else remove();
                        registered = false;
                        pageOwners.delete(pageId);
                    };
                    return Object.assign(dispose, {
                        leave,
                        associate(token: symbol) {
                            if (owner !== undefined && owner !== token) throw new Error(`Page '${pageId}' is already owned by another plugin.`);
                            owner = token;
                            pageOwners.set(pageId, token);
                        },
                        withdrawOrder: () => pages.getSnapshot().current?.id === pageId ? -200 : -100,
                        check(scope: "plugin" | "application") {
                            if (scope === "plugin" && registered && reactRoot && pages.getSnapshot().current?.id === pageId
                                && !alternative()) throw new Error(`Cannot remove the last active page '${pageId}'.`);
                        },
                        async withdraw(scope: "plugin" | "application") {
                            if (scope !== "plugin" || !registered) return;
                            if (pages.getSnapshot().current?.id === pageId) await leave();
                            dispose();
                        },
                    });
                },
                addWrapper(wrapper) {
                    checkRegistrationAllowed();
                    // 固定本次登记的描述，后续修改调用方的对象不会改变装配规则。
                    const entry = {id: wrapper.id, order: wrapper.order, wrap: wrapper.wrap, prepare: wrapper.prepare};
                    if (!entry.id.trim()) throw new Error("UI wrapper id cannot be empty.");
                    if (!Number.isFinite(entry.order)) throw new Error("UI wrapper order must be finite.");
                    if (typeof entry.wrap !== "function") throw new Error("UI wrapper must have a wrap function.");
                    if (entry.prepare !== undefined && typeof entry.prepare !== "function") throw new Error("UI wrapper prepare must be a function.");
                    if (wrappers.has(entry.id)) throw new Error(`UI wrapper '${entry.id}' is already registered.`);
                    wrappers.set(entry.id, entry);

                    const dispose = () => {
                        if (wrappers.get(entry.id) !== entry) return;
                        if (reactRoot) throw new Error(`Root wrapper '${entry.id}' cannot be removed while the UI is running.`);
                        wrappers.delete(entry.id);
                    };
                    return Object.assign(dispose, {
                        associate() {},
                        check(scope: "plugin" | "application") {
                            if (scope === "plugin" && reactRoot && wrappers.get(entry.id) === entry) {
                                throw new Error(`Root wrapper '${entry.id}' cannot be removed while the UI is running.`);
                            }
                        },
                        withdraw() {},
                    });
                },
                registerNavigationGuard(guard) {
                    checkRegistrationAllowed();
                    if (!guard || typeof guard !== "object") throw new TypeError("UI navigation guard must be an object");
                    const entry = {id: guard.id, prepare: guard.prepare};
                    if (typeof entry.id !== "string" || !entry.id.trim()) throw new Error("UI navigation guard id cannot be empty.");
                    if (typeof entry.prepare !== "function") throw new Error("UI navigation guard prepare must be a function.");
                    if (navigationGuards.has(entry.id)) throw new Error(`UI navigation guard '${entry.id}' is already registered.`);
                    navigationGuards.set(entry.id, entry);
                    let registered = true;

                    const dispose = () => {
                        if (!registered) return;
                        registered = false;
                        if (navigationGuards.get(entry.id) !== entry) return;
                        // Invalidate any awaited guard before its eventual result can commit.
                        navigationGeneration += 1;
                        navigationGuards.delete(entry.id);
                    };
                    return Object.assign(dispose, {
                        associate() {},
                        withdrawOrder: 100,
                        check(scope: "plugin" | "application") {
                            if (scope === "plugin" && registered && navigationInFlight) throw new Error("Cannot remove a navigation guard while navigation is in progress.");
                        },
                        withdraw(scope: "plugin" | "application") {
                            if (scope !== "plugin" || !registered) return;
                            registered = false;
                            if (navigationGuards.get(entry.id) === entry) navigationGuards.delete(entry.id);
                        },
                    });
                },
                openPage(id, params, options) {
                    checkNavigationAllowed();
                    return navigate(pages.previewOpen(id, params, options?.history));
                },
                back() {
                    checkNavigationAllowed();
                    return navigate(pages.previewBack());
                },
                getSnapshot() {
                    checkActive();
                    return pages.getSnapshot();
                },
                subscribe(listener) {
                    checkActive();
                    return pages.subscribe(listener);
                },
                stopForApplication() {
                    checkActive();
                    unmount();
                },
            };

            context.provide(uiKey, service);
            context.on(pluginsReady, async () => {
                if (mountAttempted) return;
                mountAttempted = true;
                const sortedWrappers = [...wrappers.values()].sort((a, b) => a.order - b.order);
                for (const entry of sortedWrappers) {
                    if (entry.prepare) await entry.prepare();
                    // 准备期间若已停用或撤销贡献，不得再创建根视图。
                    if (!active || sortedWrappers.some(wrapper => wrappers.get(wrapper.id) !== wrapper)) return;
                }
                // Read only after every wrapper has prepared; a prepare hook may update restart config.
                pages.start(config.getSnapshot(uiInitialPageConfig) ?? undefined);
                navigationAllowed = true;

                // 根视图由本插件提供；按 order 从内向外包装，最小 order 位于最外层。
                const tree = sortedWrappers.reduceRight<ReactNode>(
                    (children, entry) => entry.wrap(children),
                    <UiPages service={service}/>,
                );
                const managedRootOptions: RootOptions = {
                    ...rootOptions,
                    onUncaughtError: handleUncaughtError,
                };
                const rootContainer = container ?? (typeof document === "undefined" ? null : document.getElementById("root"));
                if (!rootContainer) throw new Error("UI root container '#root' was not found.");

                reactRoot = createRoot(rootContainer, managedRootOptions);
                try {
                    reactRoot.render(<StrictMode><ErrorBoundary>{tree}</ErrorBoundary></StrictMode>);
                } catch (error) {
                    // React can report through onUncaughtError, but a synchronous root.render
                    // exception also needs recovery and must not make pluginsReady roll back.
                    handleUncaughtError(error, {componentStack: ""});
                }
            });
        },

        deactivate() {
            const stop = cleanup;
            cleanup = undefined;
            stop?.();
        },
    };
}

function RootRenderFallback() {
    return <main className="app-startup-error" role="alert">
        <p>界面显示失败，请重新加载应用。</p>
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
    </main>;
}
