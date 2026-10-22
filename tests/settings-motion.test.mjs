import assert from "node:assert/strict";
import test from "node:test";
import { uiPluginFixture } from "./helpers/uiPluginFixture.mjs";

function findElement(node, name) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, name);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  if (node.type?.name === name) return node;
  return findElement(node.props?.children, name);
}

function findByRole(node, role) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByRole(child, role);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  if (node.props?.role === role) return node;
  return findByRole(node.props?.children, role);
}

test("motion preference keeps the effective selection after a failed write and retries the requested value", async () => {
  const f = uiPluginFixture();
  await f.mountUi();
  const { MotionSettings } = f.loadSource("plugins/settings/MotionSettings.tsx");
  const instance = {};
  const render = () => f.withHooks(instance, () => MotionSettings({ config: f.config }));

  assert.equal(findElement(render(), "Select").props.value, "system");
  f.configFaults.writeError = new Error("disk full");
  findElement(render(), "Select").props.onValueChange("reduce");
  await new Promise(resolve => setImmediate(resolve));

  const failed = render();
  assert.equal(f.config.getSnapshot(f.uiMotionConfig), "system");
  assert.equal(findElement(failed, "Select").props.value, "system");
  assert.match(findByRole(failed, "alert").props.children[0].props.children, /未能保存/);

  f.configFaults.writeError = null;
  findElement(failed, "Button").props.onClick();
  await new Promise(resolve => setImmediate(resolve));

  const retried = render();
  assert.equal(f.config.getSnapshot(f.uiMotionConfig), "reduce");
  assert.equal(findElement(retried, "Select").props.value, "reduce");
  assert.equal(findByRole(retried, "alert"), undefined);
  await f.core.unmount("ui");
});
