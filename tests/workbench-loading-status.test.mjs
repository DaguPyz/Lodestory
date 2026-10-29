import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function textContent(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  return node.props ? textContent(node.props.children) : "";
}

test("workbench startup progress is rendered as a compact status-bar item only for the active loading session", () => {
  const fixture = createMainFixture();
  const {WorkbenchLoadingStatus} = fixture.loadModule("plugins/workbench/WorkbenchLoadingStatus.tsx");
  const session = {id: "status-session", project: {id: "status-project", name: "项目", path: "/stories/status"}};
  let snapshot = {session, busy: true, loading: {completed: 4, total: 8, current: "大纲时间线", error: null}};
  const workbench = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  };

  const status = WorkbenchLoadingStatus({workbench});
  assert.equal(status.props.className, "workbench-status-loading");
  assert.match(textContent(status), /正在加载大纲时间线…/);
  assert.match(textContent(status), /4\/8/);
  const progress = status.props.children.find(child => child?.type === "progress");
  assert.ok(progress, "the bottom-bar item includes a native progress element");
  assert.equal(progress.props["aria-label"], "工作台加载进度");
  assert.equal(progress.props.max, 8);
  assert.equal(progress.props.value, 4);

  snapshot = {session, busy: false, loading: null};
  assert.equal(WorkbenchLoadingStatus({workbench}), null, "completed startup removes the item");

  snapshot = {session, busy: true, loading: {completed: 4, total: 8, current: "大纲时间线", error: {message: "初始化失败"}}};
  assert.equal(WorkbenchLoadingStatus({workbench}), null, "failed startup uses the separate recovery state");

  snapshot = {session: null, busy: true, loading: {completed: 0, total: 8, current: null, error: null}};
  assert.equal(WorkbenchLoadingStatus({workbench}), null, "a sessionless cleanup transition has no progress item");
});
