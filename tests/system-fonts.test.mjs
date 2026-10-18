import assert from "node:assert/strict";
import test from "node:test";
import {createMainFixture} from "./helpers/mainStartupFixture.mjs";

function loadSystemFontLoader(fixture) {
  const {createSystemFontLoader} = fixture.loadModule("plugins/rich-text-editor/systemFonts.ts");
  return createSystemFontLoader();
}

test("a loader preserves, deduplicates, sorts, and caches the native font family list", async () => {
  let resolveFonts;
  const fixture = createMainFixture({
    invokeHandler(command) {
      assert.equal(command, "list_system_font_families");
      return new Promise(resolve => { resolveFonts = resolve; });
    },
  });
  const loadFamilies = loadSystemFontLoader(fixture);

  const first = loadFamilies();
  const second = loadFamilies();
  resolveFonts([
    " Noto Sans CJK SC ",
    "  Edge Space Family  ",
    "Arial",
    "arial",
    "O'Connor Sans",
    "宋体",
    "",
    "   ",
    12,
    "Bad\nName",
  ]);

  const expected = ["  Edge Space Family  ", " Noto Sans CJK SC ", "Arial", "O'Connor Sans", "宋体"];
  assert.deepEqual(await first, expected);
  assert.deepEqual(await second, expected);
  assert.deepEqual(await loadFamilies(), expected);
  assert.equal(fixture.tauriCalls.length, 1, "concurrent and later reads reuse the completed request");
});

test("a failed native enumeration can be retried, while browser mode rejects without invoking Tauri", async () => {
  let attempts = 0;
  const fixture = createMainFixture({
    invokeHandler(command) {
      assert.equal(command, "list_system_font_families");
      attempts++;
      if (attempts === 1) throw new Error("native font service unavailable");
      return ["Arial"];
    },
  });
  const loadFamilies = loadSystemFontLoader(fixture);

  await assert.rejects(loadFamilies(), /native font service unavailable/);
  assert.deepEqual(await loadFamilies(), ["Arial"]);
  assert.equal(attempts, 2);

  const browserFixture = createMainFixture({tauri: false});
  const loadBrowserFamilies = loadSystemFontLoader(browserFixture);
  await assert.rejects(loadBrowserFamilies(), /桌面应用/);
  assert.equal(browserFixture.tauriCalls.length, 0);
});

test("an invalid native response is rejected instead of being reported as a complete font list", async () => {
  const fixture = createMainFixture({invokeHandler: () => ({families: ["Arial"]})});
  const loadFamilies = loadSystemFontLoader(fixture);

  await assert.rejects(loadFamilies(), /格式无效/);
});

test("separate loader instances keep independent successful caches", async () => {
  let attempts = 0;
  const fixture = createMainFixture({
    invokeHandler(command) {
      assert.equal(command, "list_system_font_families");
      attempts++;
      return ["Font " + attempts];
    },
  });
  const loadFirst = loadSystemFontLoader(fixture);
  const loadSecond = loadSystemFontLoader(fixture);

  assert.deepEqual(await loadFirst(), ["Font 1"]);
  assert.deepEqual(await loadSecond(), ["Font 2"]);
  assert.deepEqual(await loadFirst(), ["Font 1"]);
  assert.deepEqual(await loadSecond(), ["Font 2"]);
  assert.equal(attempts, 2, "each loader caches its own successful result");
});
