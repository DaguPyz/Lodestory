import {StartupError} from "../../plugin-core";

/** Show the last-resort page after the core has rolled back a failed startup. */
export function showUiStartupError(
    error: unknown,
    container: Element | DocumentFragment | null = document.getElementById("root"),
): void {
    const startupError = error instanceof StartupError ? error.startupError : error;
    const cleanupErrors = error instanceof StartupError ? [error.cleanupError] : [];
    console.error("Application failed to start.", {startupError, cleanupErrors});
    if (!container) return;

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
