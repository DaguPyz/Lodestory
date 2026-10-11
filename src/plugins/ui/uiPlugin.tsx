import {StrictMode, type ReactNode} from "react";
import {createRoot, type Root, type RootOptions} from "react-dom/client";
import type {Plugin} from "../../plugin-core";
import {pluginsReady} from "../../plugin-core";
import {uiKey, type UiService, type UiWrapper} from "./uiService";

/**
 * 宿主通过工厂参数给出挂载容器。插件只认识根视图和包装规则，不导入具体业务组件。
 * activate 创建登记表并订阅 ready；全部贡献登记完成后，ready 回调才组装和渲染。
 */
export function createUiPlugin(container: Element | DocumentFragment, rootOptions?: RootOptions): Plugin {
    let cleanup: (() => void) | undefined;

    return {
        id: "ui",
        requires: [],
        provides: [uiKey],

        activate(context) {
            // 每次激活使用独立的 C，旧服务和旧撤销函数不能影响下一次激活。
            const C: {
                root?: { render: () => ReactNode };
                wrappers: Map<string, UiWrapper>;
            } = {wrappers: new Map()};
            let active = true;
            let mountAttempted = false;
            let reactRoot: Root | undefined;

            function unmount() {
                const root = reactRoot;
                reactRoot = undefined;
                root?.unmount();
            }

            cleanup = () => {
                active = false;
                try {
                    unmount();
                } finally {
                    C.root = undefined;
                    C.wrappers.clear();
                }
            };

            function checkRegistrationAllowed() {
                if (!active) throw new Error("UI service is no longer active.");
                if (mountAttempted) throw new Error("UI contributions must be registered before pluginsReady.");
            }

            const service: UiService = {
                setRoot(render) {
                    checkRegistrationAllowed();
                    if (C.root) throw new Error("UI root is already registered.");
                    if (typeof render !== "function") throw new Error("UI root must be a render function.");
                    const entry = {render};
                    C.root = entry;

                    return () => {
                        if (C.root !== entry) return;
                        // 在贡献者释放资源之前，先停止消费这些资源的 React 组件。
                        try {
                            unmount();
                        } finally {
                            C.root = undefined;
                        }
                    };
                },
                addWrapper(wrapper) {
                    checkRegistrationAllowed();
                    // 固定本次登记的描述，后续修改调用方的对象不会改变装配规则。
                    const entry = {id: wrapper.id, order: wrapper.order, wrap: wrapper.wrap};
                    if (!entry.id.trim()) throw new Error("UI wrapper id cannot be empty.");
                    if (!Number.isFinite(entry.order)) throw new Error("UI wrapper order must be finite.");
                    if (typeof entry.wrap !== "function") throw new Error("UI wrapper must have a wrap function.");
                    if (C.wrappers.has(entry.id)) throw new Error(`UI wrapper '${entry.id}' is already registered.`);
                    C.wrappers.set(entry.id, entry);

                    return () => {
                        if (C.wrappers.get(entry.id) !== entry) return;
                        try {
                            unmount();
                        } finally {
                            C.wrappers.delete(entry.id);
                        }
                    };
                },
            };

            context.provide(uiKey, service);
            context.on(pluginsReady, () => {
                if (mountAttempted) return;
                mountAttempted = true;
                if (!C.root) throw new Error("UI root is not registered.");

                // 先得到根视图，再从内向外调用包装函数；最终最小 order 位于最外层。
                const wrappers = [...C.wrappers.values()].sort((a, b) => a.order - b.order);
                const tree = wrappers.reduceRight<ReactNode>(
                    (children, entry) => entry.wrap(children),
                    C.root.render(),
                );
                reactRoot = createRoot(container, rootOptions);
                reactRoot.render(<StrictMode>{tree}</StrictMode>);
            });
        },

        deactivate() {
            const stop = cleanup;
            cleanup = undefined;
            stop?.();
        },
    };
}
