type CloseErrorActions = {retry?: () => void; finish?: () => void};

function errorDetail(error: unknown): string {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && "cause" in current && current.cause && !seen.has(current)) {
    seen.add(current);
    current = current.cause;
  }
  if (current && typeof current === "object" && "message" in current && typeof current.message === "string") return current.message;
  return typeof current === "string" ? current : "请检查未完成的操作。";
}

/** 停止失败后，独立于可能已经卸载的 React 视图提供恢复入口。 */
export function showUiShutdownError(error: unknown, actions: CloseErrorActions): () => void {
  const page = document.createElement("section");
  const viewAvailable = !!document.getElementById("root")?.hasChildNodes();
  page.className = `app-shutdown-error${viewAvailable ? "" : " app-shutdown-error--standalone"}`;
  page.setAttribute("role", "alert");

  const heading = document.createElement("h1");
  heading.textContent = "应用未能关闭";
  const description = document.createElement("p");
  description.textContent = actions.finish
    ? `应用停止后仍有操作未完成：${errorDetail(error)}。请确认后关闭窗口。`
    : `${errorDetail(error)}。请处理后重试关闭。`;
  const action = document.createElement("button");
  action.type = "button";
  action.textContent = actions.finish ? "关闭窗口" : "重试关闭";
  action.addEventListener("click", () => (actions.finish ?? actions.retry)?.());
  page.append(heading, description, action);

  if (viewAvailable && !actions.finish) {
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "返回工作区";
    dismiss.addEventListener("click", () => page.remove());
    page.append(dismiss);
  }
  document.body.append(page);
  return () => page.remove();
}
