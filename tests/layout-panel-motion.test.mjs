import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

const f = createMainFixture();
const {
  initialLayoutPanelPresence,
  reconcileLayoutPanelPresence,
  completeLayoutPanelEnter,
  completeLayoutPanelExit,
} = f.loadModule("plugins/default-layout/panelPresence.ts");

test("overlay close retains only presentation; active content and quick reversal use the latest state", () => {
  const entering = reconcileLayoutPanelPresence(initialLayoutPanelPresence, "navigation", true);
  assert.deepEqual([entering.id, entering.phase], ["navigation", "entering"]);
  const open = completeLayoutPanelEnter(entering, entering.revision);
  const exiting = reconcileLayoutPanelPresence(open, null, true);
  assert.deepEqual([exiting.id, exiting.phase], ["navigation", "exiting"]);

  const reversed = reconcileLayoutPanelPresence(exiting, "outline", true);
  assert.deepEqual([reversed.id, reversed.phase], ["outline", "open"]);
  assert.strictEqual(completeLayoutPanelExit(reversed, exiting.revision), reversed,
    "a stale exit completion cannot hide reopened content");

  const closingAgain = reconcileLayoutPanelPresence(reversed, null, true);
  assert.deepEqual([closingAgain.id, closingAgain.phase], ["outline", "exiting"]);
  const hidden = completeLayoutPanelExit(closingAgain, closingAgain.revision);
  assert.deepEqual([hidden.id, hidden.phase], [null, "hidden"]);
});

test("docked close and inactive-layout close skip presentation exit", () => {
  const open = reconcileLayoutPanelPresence(initialLayoutPanelPresence, "navigation", false);
  assert.deepEqual([open.id, open.phase], ["navigation", "open"]);
  const dockedClosed = reconcileLayoutPanelPresence(open, null, false);
  assert.deepEqual([dockedClosed.id, dockedClosed.phase], [null, "hidden"]);

  const overlayOpen = reconcileLayoutPanelPresence(initialLayoutPanelPresence, "navigation", true);
  const inactiveClosed = reconcileLayoutPanelPresence(overlayOpen, null, false);
  assert.deepEqual([inactiveClosed.id, inactiveClosed.phase], [null, "hidden"]);
});

test("panel motion uses shared durations and preserves an 8px resize hit area", async () => {
  const {readFile} = await import("node:fs/promises");
  const css = await readFile(new URL("../src/plugins/default-layout/layout.css", import.meta.url), "utf8");
  const component = await readFile(new URL("../src/plugins/default-layout/DefaultLayout.tsx", import.meta.url), "utf8");
  assert.match(css, /transition-duration:\s*var\(--ui-duration-normal\)/);
  assert.match(css, /transition-duration:\s*var\(--ui-duration-fast\)/);
  assert.match(css, /var\(--ui-motion-offset\)/);
  assert.match(css, /data-ui-motion="reduce"\]\s*\.layout-panel\[data-overlay="true"\]\s*\{\s*transition-property:\s*none/s);
  assert.match(css, /data-motion-enabled="false"\]\s*\{\s*transition-property:\s*none/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?transition-property:\s*none/);
  assert.match(css, /data-ui-motion="reduce"\][\s\S]*?animation-name:\s*none/);
  assert.match(component, /addEventListener\("animationcancel"/);
  assert.match(css, /\.layout-navigation-resizer\s*\{[^}]*width:\s*8px/s);
  assert.doesNotMatch(css, /transition:\s*all\b/);
});
