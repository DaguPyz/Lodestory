import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import {createAppRuntime, type AppRuntime} from "./app/createAppRuntime";
import {ContextMenuProvider} from "./components/context-menu";
import {ThemeProvider} from "./theme/ThemeProvider";
import {createThemePlugin} from "./theme/themePlugin";
import {themeKey} from "./theme/themeService";
import "./styles.css";

const container = document.getElementById("root")!;
let runtime: AppRuntime | undefined;
let root: ReactDOM.Root | undefined;
let failure: Promise<void> | undefined;

function showStartupError() {
    // 错误页面直接使用 DOM，避免业务组件渲染失败后再次依赖同一棵 React 树。
    const page = document.createElement("main");
    page.className = "app-startup-error";
    page.setAttribute("role", "alert");
    const heading = document.createElement("h1");
    heading.textContent = "应用启动失败";
    const description = document.createElement("p");
    description.textContent = "无法进入工作空间，请重新加载应用。";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "重新加载";
    reload.addEventListener("click", () => window.location.reload());
    page.append(heading, description, reload);
    container.replaceChildren(page);
}

function failStartup(startupError: unknown): Promise<void> {
    // React 的错误回调可能发生在渲染过程中；下一微任务再卸载，重复报错只清理一次。
    failure ??= Promise.resolve().then(async () => {
        const cleanupErrors: unknown[] = [];
        try {
            root?.unmount();
        } catch (error) {
            cleanupErrors.push(error);
        }
        showStartupError();
        try {
            await runtime?.stop();
        } catch (error) {
            cleanupErrors.push(error);
        }
        console.error("Application failed to start.", {startupError, cleanupErrors});
    });
    return failure;
}

async function start() {
    try {
        runtime = await createAppRuntime([createThemePlugin()]);
        const theme = runtime.get(themeKey);
        root = ReactDOM.createRoot(container, {
            onUncaughtError(error) {
                void failStartup(error);
            },
        });
        root.render(
            <React.StrictMode>
                <ContextMenuProvider>
                    <ThemeProvider service={theme}><App/></ThemeProvider>
                </ContextMenuProvider>
            </React.StrictMode>,
        );
    } catch (error) {
        await failStartup(error);
    }
}

void start();
