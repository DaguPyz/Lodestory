import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/plugins/asset-management/assetCardColor.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
}).outputText;
const colorExports = {};
vm.runInNewContext(compiled, {exports: colorExports, Object, Array, Number, String, Math, RegExp});
const {ASSET_COLOR_PRESETS, assetCardColorStyle, isAssetColor} = colorExports;

function luminance(color) {
  const [red, green, blue] = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function assertReadable(color) {
  assert.equal(isAssetColor(color), true, `${color} is a supported color`);
  const style = assetCardColorStyle(color);
  assert.ok(style, `${color} produces card colors`);
  assert.equal(style["--asset-card-background"], color, "the chosen background is preserved exactly");
  assert.ok(contrast(color, style["--asset-card-foreground"]) >= 4.5,
    `${color} has readable primary text`);
  assert.ok(contrast(color, style["--asset-card-secondary"]) >= 4.5,
    `${color} has readable secondary text`);
  assert.ok(contrast(style["--asset-card-badge-background"], style["--asset-card-secondary"]) >= 4.5,
    `${color} has readable badge text`);
  for (const surface of [color, style["--asset-card-hover"], style["--asset-card-pressed"]]) {
    assert.ok(contrast(surface, style["--asset-card-foreground"]) >= 3,
      `${color} keeps its focus color visible against base, hover and pressed surfaces`);
  }
}

test("preset and deterministic RGB grid colors preserve their background and meet contrast targets", () => {
  const colors = new Set(ASSET_COLOR_PRESETS.map(preset => preset.value));
  const channelValues = Array.from({length: 16}, (_, index) => index * 17);
  for (const red of channelValues) {
    for (const green of channelValues) {
      for (const blue of channelValues) {
        colors.add(`#${[red, green, blue].map(channel => channel.toString(16).padStart(2, "0")).join("")}`);
      }
    }
  }
  for (const color of colors) assertReadable(color);
});

test("uppercase hex is preserved and missing or invalid colors fall back to the default", () => {
  assertReadable("#D8E5F2");
  for (const color of [undefined, null, "", "#fff", "red", "#12xz45", "#1234567"]) {
    assert.equal(assetCardColorStyle(color), undefined, `${String(color)} has no custom card style`);
  }
});
