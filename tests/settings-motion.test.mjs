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
  const { createMotionSettingsModel } = f.loadSource("plugins/settings/motionSettingsModel.ts");
  const model = createMotionSettingsModel(f.config);
  const instance = {};
  const render = () => f.withHooks(instance, () => MotionSettings({ config: f.config, model }));

  assert.equal(findElement(render(), "Select").props.value, "system");
  f.configFaults.writeError = new Error("disk full");
  findElement(render(), "Select").props.onValueChange("reduce");
  await new Promise(resolve => setImmediate(resolve));

  const reopenedInstance = {};
  const renderReopened = () => f.withHooks(reopenedInstance, () => MotionSettings({ config: f.config, model }));
  const failed = renderReopened();
  assert.equal(f.config.getSnapshot(f.uiMotionConfig), "system");
  assert.equal(findElement(failed, "Select").props.value, "system");
  assert.match(findByRole(failed, "alert").props.children[0].props.children, /未能保存/);

  f.configFaults.writeError = null;
  findElement(failed, "Button").props.onClick();
  await new Promise(resolve => setImmediate(resolve));

  const retried = renderReopened();
  assert.equal(f.config.getSnapshot(f.uiMotionConfig), "reduce");
  assert.equal(findElement(retried, "Select").props.value, "reduce");
  assert.equal(findByRole(retried, "alert"), undefined);
  await model.dispose();
  await f.core.unmount("ui");
});

test("motion settings finish queued writes before releasing their resources", async () => {
  const f = uiPluginFixture();
  const {createMotionSettingsModel} = f.loadSource("plugins/settings/motionSettingsModel.ts");
  let finishWrite;
  const model = createMotionSettingsModel({set: () => new Promise(resolve => { finishWrite = resolve; })});
  model.save("reduce");
  await Promise.resolve();
  let stopped = false;
  const stopping = model.dispose().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finishWrite();
  await stopping;
  assert.equal(stopped, true);
});
