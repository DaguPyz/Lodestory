import {StrictMode, type ReactNode} from "react";
import {createRoot, type Root, type RootOptions} from "react-dom/client";
import type {Plugin} from "@lodestory/sdk";
import {pluginsReady} from "../../plugin-core";
import {uiKey, type UiService, type UiWrapper} from "@lodestory/sdk/ui";
import {errorUiKey} from "@lodestory/sdk/error";
import {createPageRegistry} from "./pageRegistry";
import {UiPages} from "./UiPages";

export type UiPluginOptions = {
    /** 启动时显示的页面；省略时使用第一个登记的页面。 */
    readonly initialPage?: string;
    readonly rootOptions?: RootOptions;
};

/**
 * 合并页面管理与根装配；只认识页面登记和包装规则，不导入具体业务组件。
 * ready 时选择初始页面并挂载通用页面容器，之后由页面状态驱动 React 更新。
 */
export function createUiPlugin(container?: Element | DocumentFragment, options: UiPluginOptions = {}): Plugin {
    const {initialPage, rootOptions} = options;
    let cleanup: (() => void) | undefined;

    return {
        id: "ui",
        requires: [errorUiKey],
        provides: [uiKey],

        activate(context) {
            const {ErrorBoundary} = context.get(errorUiKey);
            // 每次激活使用独立登记和状态，旧服务和旧撤销函数不能影响下一次激活。
            const pages = createPageRegistry();
            const wrappers = new Map<string, UiWrapper>();
            let active = true;
            let mountAttempted = false;
            let navigationAllowed = false;
            let reactRoot: Root | undefined;
            let renderFailureHandled = false;
            let firstRenderError: unknown;
            let rootFallbackRenderAttempted = false;
            let rootFallbackFailureReported = false;

            function unmount() {
                navigationAllowed = false;
                const root = reactRoot;
                reactRoot = undefined;
                root?.unmount();
            }

            cleanup = () => {
                active = false;
                try {
                    unmount();
                } finally {
                    pages.clear();
                    wrappers.clear();
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
                registerPage(page) {
                    checkRegistrationAllowed();
                    const remove = pages.registerPage(page);
                    let registered = true;

                    return () => {
                        if (!registered) return;
                        registered = false;
                        // 在贡献者释放资源之前，先停止消费这些资源的 React 组件。
                        try {
                            unmount();
                        } finally {
                            remove();
                        }
                    };
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

                    return () => {
                        if (wrappers.get(entry.id) !== entry) return;
                        try {
                            unmount();
                        } finally {
                            wrappers.delete(entry.id);
                        }
                    };
                },
                openPage(id, params) {
                    checkNavigationAllowed();
                    pages.openPage(id, params);
                },
                back() {
                    checkNavigationAllowed();
                    pages.back();
                },
                getSnapshot() {
                    checkActive();
                    return pages.getSnapshot();
                },
                subscribe(listener) {
                    checkActive();
                    return pages.subscribe(listener);
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
                pages.start(initialPage);
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
