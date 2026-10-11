import {createAppRuntime, type AppRuntime} from "./app/createAppRuntime";
import {createAppPlugins} from "./app/appPlugins";
import {StartupError} from "./plugin-core";

const container = document.getElementById("root")!;
let runtime: AppRuntime | undefined;
let starting: Promise<AppRuntime> | undefined;
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

function failStartup(error: unknown): Promise<void> {
    // 错误回调可能发生在渲染过程中；下一微任务再停用插件，重复报错只清理一次。
    failure ??= Promise.resolve().then(async () => {
        const cleanupErrors: unknown[] = [];
        const startupError = error instanceof StartupError ? error.startupError : error;
        if (error instanceof StartupError) cleanupErrors.push(error.cleanupError);

        // ready 响应还没结束时，React 也可能报错；等待启动结果以取得需要停用的实例。
        let activeRuntime = runtime;
        if (!activeRuntime && starting) {
            try {
                activeRuntime = await starting;
            } catch (startupFailure) {
                // 启动失败由内核负责回滚；保留回滚错误，不再重复清理。
                if (startupFailure instanceof StartupError && !cleanupErrors.includes(startupFailure.cleanupError)) {
                    cleanupErrors.push(startupFailure.cleanupError);
                }
            }
        }
        try {
            await activeRuntime?.stop();
        } catch (error) {
            cleanupErrors.push(error);
        }
        // root 由插件卸载后再显示错误页，避免卸载操作清掉这个回退页面。
        showStartupError();
        console.error("Application failed to start.", {startupError, cleanupErrors});
    });
    return failure;
}

async function start() {
    try {
        starting = createAppRuntime(createAppPlugins(container, {
            onUncaughtError(error) {
                void failStartup(error);
            },
        }));
        runtime = await starting;
    } catch (error) {
        await failStartup(error);
    }
}

void start();
