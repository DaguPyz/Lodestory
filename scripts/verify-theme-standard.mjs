import assert from "node:assert/strict";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

// 只验证本标准使用的 Schema 关键词；出现不支持的关键词即失败，不静默跳过。
const repository = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(repository, "文档/主题标准-v1");
const supported = new Set(["$schema", "$id", "title", "description", "type", "const", "enum", "properties", "required", "additionalProperties", "pattern", "minLength", "maxLength", "items", "minItems", "maxItems", "uniqueItems"]);
function checkSchema(schema) {
  for (const key of Object.keys(schema)) assert(supported.has(key), `不支持的 Schema 关键词：${key}`);
  for (const child of Object.values(schema.properties ?? {})) checkSchema(child);
  if (schema.items) checkSchema(schema.items);
  if (schema.pattern) new RegExp(schema.pattern, "u");
}
function validate(value, schema, location = "$") {
  if (Object.hasOwn(schema, "const")) assert.deepEqual(value, schema.const, `${location}: const`);
  if (schema.enum) assert(schema.enum.includes(value), `${location}: enum`);
  if (schema.type) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    assert.equal(actual, schema.type, `${location}: type`);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined) assert(length >= schema.minLength, `${location}: minLength`);
    if (schema.maxLength !== undefined) assert(length <= schema.maxLength, `${location}: maxLength`);
    if (schema.pattern) assert(new RegExp(schema.pattern, "u").test(value), `${location}: pattern`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, `${location}: minItems`);
    if (schema.maxItems !== undefined) assert(value.length <= schema.maxItems, `${location}: maxItems`);
    if (schema.uniqueItems) assert.equal(new Set(value.map((item) => JSON.stringify(item))).size, value.length, `${location}: uniqueItems`);
    if (schema.items) value.forEach((item, index) => validate(item, schema.items, `${location}[${index}]`));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) assert(Object.hasOwn(value, key), `${location}: missing ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validate(child, schema.properties[key], `${location}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${location}: additionalProperties ${key}`);
    }
  }
}
function parseJson(raw) {
  const result = JSON.parse(raw);
  const stack = [];
  const tokens = raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g);
  for (const [token] of tokens) {
    const top = stack.at(-1);
    if (token === "{") stack.push({ object: true, keys: new Set(), expectsKey: true });
    else if (token === "[") stack.push({ object: false });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && top?.object) top.expectsKey = true;
    else if (token.startsWith('"') && top?.object && top.expectsKey) {
      const key = JSON.parse(token);
      assert(!top.keys.has(key), `重复 JSON 字段：${key}`);
      top.keys.add(key);
      top.expectsKey = false;
    }
  }
  return result;
}
async function readJson(path, limit = Infinity) {
  const bytes = await readFile(path);
  assert(bytes.length <= limit, `文件超过大小限制：${path}`);
  return parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
const registry = await readJson(resolve(repository, "src/plugins/theme/color-registry.json"));
const themeSchema = await readJson(resolve(directory, "theme.schema.json"));
const manifestSchema = await readJson(resolve(directory, "manifest.schema.json"));
checkSchema(themeSchema);
checkSchema(manifestSchema);
assert.equal(registry.schemaVersion, 1);
assert.equal(registry.standardVersion, "1.0.0");
assert.deepEqual(Object.keys(themeSchema.properties.colors.properties), registry.colors.map((entry) => entry.id), "Schema 颜色清单应与登记表一致");

function compareVersion(a, b) {
  const parse = (value) => {
    assert(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value), "无效版本");
    return value.split(".").map(BigInt);
  };
  const left = parse(a), right = parse(b);
  for (let index = 0; index < 3; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}
function checkRange(range, current) {
  assert(compareVersion(range.min, range.maxExclusive) < 0, "版本区间上下界错误");
  assert(compareVersion(current, range.min) >= 0 && compareVersion(current, range.maxExclusive) < 0, `版本不兼容：${current}`);
}
function checkRegistry(data) {
  const entries = new Map(data.colors.map((entry) => [entry.id, entry]));
  assert.equal(entries.size, data.colors.length, "颜色名称重复");
  assert.equal(new Set(data.colors.map((entry) => entry.cssVariable)).size, data.colors.length, "CSS 映射重复");
  const allowedGroups = new Set(["surface", "text", "border", "accent", "focus", "caret", "selection", "state", "action", "danger", "status", "overlay", "shadow", "highlight", "drop", "link", "category"]);
  for (const entry of data.colors) assert(allowedGroups.has(entry.id.split(".")[0]), `不允许组件或插件专属角色：${entry.id}`);
  for (const type of ["dark", "light"]) {
    const finished = new Set(), visiting = new Set();
    function visit(id) {
      assert(entries.has(id), `默认引用不存在：${id}`);
      assert(!visiting.has(id), `默认引用环：${id}`);
      if (finished.has(id)) return;
      visiting.add(id);
      const entry = entries.get(id), fallback = entry.defaults[type];
      assert.equal(typeof entry.description, "string");
      assert(/^--ui-[a-z0-9-]+$/.test(entry.cssVariable));
      assert.equal(typeof entry.alphaAllowed, "boolean");
      if (typeof fallback === "string") validate(fallback, themeSchema.properties.colors.properties[id]);
      else {
        assert.deepEqual(Object.keys(fallback), ["ref"], "默认引用结构错误");
        visit(fallback.ref);
      }
      visiting.delete(id);
      finished.add(id);
    }
    for (const id of entries.keys()) visit(id);
  }
  assert.equal(new Set(data.contrastPairs.map((pair) => pair.id)).size, data.contrastPairs.length, "对比关系重复");
  for (const pair of data.contrastPairs) {
    assert(entries.has(pair.foreground) && entries.has(pair.background), `对比关系不存在：${pair.id}`);
    assert([null, 3, 4.5].includes(pair.minRatio));
    if (pair.minRatio === null) assert(["text.disabled", "state.disabledForeground", "state.disabledSelectedForeground", "state.disabledBorder"].includes(pair.foreground), "豁免必须明确属于禁用角色");
  }
  for (const recipe of data.shadowRecipes) for (const layer of recipe.layers) {
    assert(entries.has(layer.color) && layer.color.startsWith("shadow."));
    for (const key of ["x", "y", "blur", "spread"]) assert(Number.isFinite(layer[key]));
    assert(layer.blur >= 0);
  }
  checkUsageRules(data, entries);
  return entries;
}
function checkUsageRules(data, entries) {
  for (const [id, context] of Object.entries(data.contexts)) {
    assert(context.allowedRoles.length > 0, `上下文为空：${id}`);
    assert.equal(new Set(context.allowedRoles).size, context.allowedRoles.length, "上下文角色重复");
    for (const role of context.allowedRoles) assert(entries.has(role), `上下文引用不存在：${role}`);
    if (!context.required) assert(context.allowedRoles.includes(context.defaultRole), "上下文缺省不在允许角色中");
  }
  const expand = (reference) => {
    if (typeof reference === "string") {
      assert(entries.has(reference), `搭配引用不存在：${reference}`);
      return [reference];
    }
    assert.deepEqual(Object.keys(reference), ["context"], "搭配组合只能引用角色或上下文");
    assert(Object.hasOwn(data.contexts, reference.context), "搭配上下文不存在");
    return data.contexts[reference.context].allowedRoles;
  };
  const paired = (foreground, background) => data.contrastPairs.find((pair) => pair.foreground === foreground && pair.background === background);
  for (const [id, paint] of Object.entries(data.paintSets)) {
    assert(paint.background && (paint.foreground || paint.indicator || paint.border), `搭配缺少前景背景：${id}`);
    for (const key of Object.keys(paint)) assert(["description", "foreground", "background", "border", "indicator"].includes(key), "搭配组合不能存第二层颜色");
    const backgrounds = expand(paint.background);
    for (const key of ["foreground", "border", "indicator"]) if (paint[key]) {
      for (const foreground of expand(paint[key])) for (const background of backgrounds) {
        const pair = paired(foreground, background);
        assert(pair, `搭配未登记对比关系：${id}/${foreground}/${background}`);
        const exempt = ["text.disabled", "state.disabledForeground", "state.disabledSelectedForeground", "state.disabledBorder"].includes(foreground);
        const required = exempt ? null : key === "foreground" && id !== "caret" ? 4.5 : 3;
        assert.equal(pair.minRatio, required, `搭配对比目标错误：${id}/${foreground}/${background}`);
      }
    }
  }
  assert.deepEqual(data.stateRules.intents, ["neutral", "action", "danger"]);
  for (const rule of [...data.stateRules.priority, data.stateRules.focus]) {
    for (const [flag, value] of Object.entries(rule.when)) {
      assert(Object.hasOwn(data.stateRules.defaults, flag), "状态条件没有默认语义");
      assert.equal(typeof value, "boolean");
    }
    const paints = rule.paint ? [rule.paint] : data.stateRules.intents.map((intent) => rule.paints[intent]);
    for (const paint of paints) assert(Object.hasOwn(data.paintSets, paint), `状态组合不存在：${paint}`);
  }
  assert.deepEqual(data.stateRules.priority.at(-1).when, {}, "状态规则必须有末尾默认项");
  assert.equal(data.stateRules.focus.independent, true, "焦点必须正交叠加");
  assert.deepEqual(Object.keys(data.usageRules), ["feedback", "highlight", "drop", "link", "inverse", "category"], "六类扩展用途必须完整登记");
  for (const [id, usage] of Object.entries(data.usageRules)) {
    assert(usage.description && usage.rules.length > 0, `缺少用途说明：${id}`);
    const paints = [...(usage.paints ?? [])];
    if (usage.priority) {
      assert.deepEqual(usage.priority.at(-1).when, {}, "扩展状态必须有末尾默认项");
      for (const value of Object.values(usage.defaults)) assert.equal(typeof value, "boolean");
      for (const rule of usage.priority) {
        for (const [flag, value] of Object.entries(rule.when)) {
          assert(Object.hasOwn(usage.defaults, flag), "扩展状态条件没有默认语义");
          assert.equal(typeof value, "boolean");
        }
        if (rule.paint !== null) paints.push(rule.paint);
      }
    }
    for (const paint of paints) assert(Object.hasOwn(data.paintSets, paint), `扩展组合不存在：${paint}`);
  }
  assert(data.distinctionChecks.length > 0, "缺少分类辨识检查");
  for (const check of data.distinctionChecks) {
    assert.equal(check.rule, "differentResolvedRGB");
    assert.equal(check.severity, "warning");
    assert(check.roles.length > 1 && new Set(check.roles).size === check.roles.length);
    for (const role of check.roles) assert(entries.has(role), "辨识检查引用不存在");
  }
}
const entries = checkRegistry(registry);
const simulatedHost = { appVersion: "0.1.0", themeStandardVersion: "1.0.0" };
function resolveColors(theme) {
  const result = {}, visiting = new Set();
  function visit(id) {
    if (Object.hasOwn(result, id)) return result[id];
    assert(!visiting.has(id), `颜色引用环：${id}`);
    visiting.add(id);
    const fallback = entries.get(id).defaults[theme.type];
    result[id] = Object.hasOwn(theme.colors, id) ? theme.colors[id] : typeof fallback === "string" ? fallback : visit(fallback.ref);
    validate(result[id], themeSchema.properties.colors.properties[id], id);
    visiting.delete(id);
    return result[id];
  }
  for (const id of entries.keys()) visit(id);
  return result;
}
function paintRoles(id, suppliedContext = {}) {
  assert(Object.hasOwn(registry.paintSets, id), "未知配色组合");
  for (const key of Object.keys(suppliedContext)) assert(Object.hasOwn(registry.contexts, key), "上下文不能增加颜色");
  for (const [key, role] of Object.entries(suppliedContext)) assert(registry.contexts[key].allowedRoles.includes(role), `上下文角色不允许：${key}`);
  return Object.fromEntries(Object.entries(registry.paintSets[id]).filter(([key]) => key !== "description").map(([key, reference]) => {
    if (typeof reference === "string") return [key, reference];
    const definition = registry.contexts[reference.context];
    if (definition.required) assert(Object.hasOwn(suppliedContext, reference.context), "必须指定实际承载表面");
    return [key, suppliedContext[reference.context] ?? definition.defaultRole];
  }));
}
function resolveUsage(family, suppliedContext = {}, suppliedState = {}) {
  const usage = registry.usageRules[family];
  assert(usage?.priority, "未知扩展状态用途");
  for (const [flag, value] of Object.entries(suppliedState)) {
    assert(Object.hasOwn(usage.defaults, flag), "未知扩展状态标记");
    assert.equal(typeof value, "boolean", "扩展状态必须是布尔值");
  }
  const state = { ...usage.defaults, ...suppliedState };
  const rule = usage.priority.find(rule => Object.entries(rule.when).every(([flag, value]) => state[flag] === value));
  return { id: rule.paint, roles: rule.paint === null ? null : paintRoles(rule.paint, suppliedContext) };
}
function resolvePaint(intent, suppliedContext, suppliedState = {}) {
  assert(registry.stateRules.intents.includes(intent), "未知视觉用途");
  assert(Object.hasOwn(suppliedContext, "surface"), "必须指定实际承载表面");
  for (const [flag, value] of Object.entries(suppliedState)) {
    assert(Object.hasOwn(registry.stateRules.defaults, flag), "未知状态标记");
    assert.equal(typeof value, "boolean", "状态标记必须是布尔值");
  }
  const state = { ...registry.stateRules.defaults, ...suppliedState };
  const matches = (rule) => Object.entries(rule.when).every(([flag, value]) => state[flag] === value);
  const rule = registry.stateRules.priority.find(matches);
  const id = rule.paint ?? rule.paints[intent];
  return {
    id,
    roles: paintRoles(id, suppliedContext),
    focus: matches(registry.stateRules.focus) ? paintRoles(registry.stateRules.focus.paint, suppliedContext) : null,
  };
}
function validatePackage(manifest, themes, builtin = false, host = simulatedHost) {
  validate(manifest, manifestSchema);
  assert(manifest.name.trim().length > 0, "包名称为空白");
  assert.equal(manifest.publisher, manifest.id.split(".")[0], "发行者与包 ID 不一致");
  assert(builtin || manifest.publisher !== "lodestory", "保留的内置命名空间");
  assert(host.themeStandardVersion, "宿主未声明主题标准能力");
  checkRange(manifest.compatibility.themeStandard, host.themeStandardVersion);
  checkRange(manifest.compatibility.lodestory, host.appVersion);
  assert.equal(manifest.contributes.themes.length, themes.length);
  assert.equal(new Set(manifest.contributes.themes.map((item) => item.path)).size, themes.length, "主题路径重复");
  assert.equal(new Set(themes.map((theme) => theme.id)).size, themes.length, "主题 ID 重复");
  const warnings = [];
  for (const theme of themes) {
    validate(theme, themeSchema);
    assert(theme.name.trim().length > 0, "主题名称为空白");
    assert(theme.id.startsWith(manifest.id + "."), "主题不属于当前包");
    warnings.push(...collectWarnings(resolveColors(theme)).map(warning => ({ themeId: theme.id, ...warning })));
  }
  return { warnings };
}
async function loadPackage(name, builtin = false) {
  const folder = resolve(directory, "examples", name);
  const manifest = await readJson(resolve(folder, "manifest.json"), 64 * 1024);
  validate(manifest, manifestSchema);
  const allowed = new Set(["manifest.json", ...manifest.contributes.themes.map((item) => item.path)]);
  let bytes = 0;
  async function walk(path) {
    for (const item of await readdir(path)) {
      const child = resolve(path, item), stat = await lstat(child);
      assert(!stat.isSymbolicLink(), "不允许链接文件");
      if (stat.isDirectory()) await walk(child);
      else {
        assert(stat.isFile(), "必须是普通文件");
        assert(allowed.has(relative(folder, child).split("\\").join("/")), "包内存在未声明文件");
        bytes += stat.size;
      }
    }
  }
  await walk(folder);
  assert(bytes <= 5 * 1024 * 1024, "包总大小超限");
  const themes = [];
  for (const item of manifest.contributes.themes) {
    const path = await realpath(resolve(folder, item.path));
    assert(path.startsWith(folder + "/"), "主题文件越过包边界");
    themes.push(await readJson(path, 256 * 1024));
  }
  validatePackage(manifest, themes, builtin);
  return { manifest, themes };
}
const builtin = {
  themes: await Promise.all(["dark", "light"].map(type => readJson(resolve(repository, `src/plugins/builtin-themes/${type}.theme.json`), 256 * 1024))),
};
for (const theme of builtin.themes) validate(theme, themeSchema);
const ink = await loadPackage("ink");

function rgba(color) {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).concat(hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1);
  }
  const match = /^rgba\(([^)]+)\)$/.exec(color);
  assert(match, "无效 CSS 基线色");
  return match[1].split(",").map(Number);
}
function contrast(foreground, background) {
  const luminance = (color) => {
    const channels = rgba(color);
    assert.equal(channels[3], 1, "当前对比关系必须使用不透明颜色");
    return channels.slice(0, 3).map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
function collectWarnings(palette) {
  const warnings = [];
  for (const pair of registry.contrastPairs) {
    if (pair.minRatio === null) continue;
    const foreground = palette[pair.foreground], background = palette[pair.background];
    const actualRatio = contrast(foreground, background);
    if (actualRatio < pair.minRatio) warnings.push({ kind: "contrast", id: pair.id, foreground, background, actualRatio, minRatio: pair.minRatio });
  }
  for (const check of registry.distinctionChecks) {
    for (let i = 0; i < check.roles.length; i++) for (let j = i + 1; j < check.roles.length; j++) {
      const a = check.roles[i], b = check.roles[j];
      if (rgba(palette[a]).slice(0, 3).join(",") === rgba(palette[b]).slice(0, 3).join(",")) {
        warnings.push({ kind: "distinction", id: check.id, roles: [a, b], colors: [palette[a], palette[b]] });
      }
    }
  }
  return warnings;
}
const css = await readFile(resolve(repository, "tests/fixtures/builtin-colors.css"), "utf8");
let compared = 0;
for (const theme of builtin.themes) {
  const selector = theme.type === "dark" ? /:root,\s*\[data-ui-theme="dark"\]\s*\{([\s\S]*?)\}/ : /\[data-ui-theme="light"\]\s*\{([\s\S]*?)\}/;
  const block = selector.exec(css)?.[1];
  assert(block, "现有主题 CSS 块不存在");
  const variables = new Map([...block.matchAll(/(--ui-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
  const palette = resolveColors(theme);
  function checkColor(actual, expected) {
    const a = rgba(actual), b = rgba(expected);
    assert.deepEqual(a.slice(0, 3), b.slice(0, 3), "内置基线 RGB 应保持一致");
    assert(Math.abs(a[3] - b[3]) <= .5 / 255 + 1e-12, "透明度量化误差超限");
    compared++;
  }
  for (const entry of registry.colors) if (variables.has(entry.cssVariable)) checkColor(palette[entry.id], variables.get(entry.cssVariable));
  for (const recipe of registry.shadowRecipes) {
    const legacy = variables.get(recipe.cssVariable);
    const layers = [...legacy.matchAll(/(-?[\d.]+)(?:px)?\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?\s+(rgba\([^)]+\))/g)];
    assert.equal(layers.length, recipe.layers.length);
    recipe.layers.forEach((layer, index) => {
      assert.deepEqual([layer.x, layer.y, layer.blur, layer.spread], layers[index].slice(1, 5).map((value) => Number(value ?? 0)));
      checkColor(palette[layer.color], layers[index][5]);
    });
  }
  for (const pair of registry.contrastPairs) if (pair.minRatio !== null) assert(contrast(palette[pair.foreground], palette[pair.background]) >= pair.minRatio, `内置基线低对比度：${theme.type}/${pair.id}`);
  assert.deepEqual(collectWarnings(palette), [], "内置主题应通过全部静态检查");
}
const partial = resolveColors(ink.themes[0]);
assert.equal(partial["surface.content"], "#171A23");
assert.equal(partial["text.reading"], "#ECE2CE");
assert.equal(partial["state.selectedHoverForeground"], "#F5EDFF");
assert.equal(partial["state.selectedPressedForeground"], "#F5EDFF");
const inherited = resolveColors({ type: "dark", colors: { "text.onAction": "#FDFDFD", "state.selectedForeground": "#FEFEFE" } });
assert.equal(inherited["action.foreground"], "#FDFDFD");
assert.equal(inherited["danger.foreground"], "#FDFDFD");
assert.equal(inherited["state.inactiveSelectedForeground"], "#FEFEFE");
assert.equal(resolveColors({ type: "light", colors: {} })["text.primary"], "#18212D");
const extendedInherited = resolveColors({ type: "dark", colors: { "status.info": "#AABBCC", "status.infoBackground": "#101820", "category.1.foreground": "#DDEEFF" } });
assert.equal(extendedInherited["status.infoForeground"], "#AABBCC");
assert.equal(extendedInherited["drop.allowedForeground"], "#AABBCC");
assert.equal(extendedInherited["drop.allowedBackground"], "#101820");
assert.equal(extendedInherited["category.1.border"], "#DDEEFF");
for (const type of ["dark", "light"]) {
  assert.deepEqual(collectWarnings(resolveColors({ type, colors: {} })), [], "完全缺省主题必须覆盖全部新增场景");
}

const context = { surface: "surface.content", foreground: "text.reading" };
const vectors = [
  ["neutral", {}, "neutral"],
  ["neutral", { hovered: true }, "hover"],
  ["neutral", { hovered: true, pressed: true }, "pressed"],
  ["neutral", { selected: true }, "selected"],
  ["neutral", { selected: true, hovered: true }, "selectedHover"],
  ["neutral", { selected: true, hovered: true, pressed: true }, "selectedPressed"],
  ["neutral", { selected: true, selectionActive: false }, "inactiveSelected"],
  ["neutral", { selected: true, selectionActive: false, hovered: true }, "selectedHover"],
  ["neutral", { selected: true, selectionActive: false, pressed: true }, "selectedPressed"],
  ["neutral", { disabled: true, hovered: true, pressed: true }, "disabled"],
  ["danger", { disabled: true, selected: true, pressed: true }, "disabledSelected"],
  ["action", {}, "actionRest"],
  ["action", { hovered: true }, "actionHover"],
  ["action", { hovered: true, pressed: true }, "actionPressed"],
  ["danger", {}, "dangerRest"],
  ["danger", { hovered: true }, "dangerHover"],
  ["danger", { hovered: true, pressed: true }, "dangerPressed"],
  ["action", { selected: true, hovered: true }, "selectedHover"],
];
for (const [intent, state, expected] of vectors) assert.equal(resolvePaint(intent, context, state).id, expected);
assert.deepEqual(resolvePaint("neutral", context).roles, { foreground: "text.reading", background: "surface.content", border: "border.strong" });
let stateCases = 0;
const flags = Object.keys(registry.stateRules.defaults);
for (const intent of registry.stateRules.intents) for (let mask = 0; mask < 2 ** flags.length; mask++) {
  const state = Object.fromEntries(flags.map((flag, index) => [flag, Boolean(mask & (1 << index))]));
  const result = resolvePaint(intent, context, state);
  if (state.disabled) assert.equal(result.id, state.selected ? "disabledSelected" : "disabled");
  if (state.selected) assert.equal(result.roles.indicator, "accent.indicator", "选中状态不能丢失指示");
  assert.equal(result.focus !== null, state.focusVisible, "焦点不应被背景前景状态吞掉");
  if (result.focus) assert.equal(result.focus.indicator, "focus.ring");
  stateCases++;
}

// 枚举相互冲突的状态，按独立预期核对优先级，而非仅重放登记表。
let extendedCases = 0;
for (const family of ["highlight", "drop", "link"]) {
  const flags = Object.keys(registry.usageRules[family].defaults);
  for (let mask = 0; mask < 2 ** flags.length; mask++) {
    const state = Object.fromEntries(flags.map((flag, index) => [flag, Boolean(mask & (1 << index))]));
    let expected;
    if (family === "highlight") expected = state.textSelected ? "selection" : state.current ? "highlightActive" : "highlight";
    if (family === "drop") expected = state.disabled || !state.dragging ? null : !state.allowed ? "dropForbidden" : state.insertion ? "dropInsertion" : "dropAllowed";
    if (family === "link") expected = state.inheritForeground ? null : state.disabled ? "linkDisabled" : state.visited ? state.pressed ? "linkVisitedPressed" : state.hovered ? "linkVisitedHover" : "linkVisited" : state.pressed ? "linkPressed" : state.hovered ? "linkHover" : "linkRest";
    assert.equal(resolveUsage(family, { surface: "surface.content" }, state).id, expected);
    extendedCases++;
  }
}
assert.deepEqual(paintRoles("inverse"), { foreground: "text.inverse", background: "surface.inverse", border: "border.inverse" });
assert.equal(paintRoles("inverseFocus").indicator, "focus.inverseRing");
assert.equal(paintRoles("focusExtended", { adjacentSurface: "status.warningBackground" }).background, "status.warningBackground");
for (const surface of registry.contexts.validationSurface.allowedRoles) {
  const boundary = paintRoles("validationDanger", { validationSurface: surface });
  assert.deepEqual(boundary, { border: "status.dangerBorder", background: surface }, "校验边界不能替换文字或底色");
}
const selectedFocused = resolvePaint("neutral", context, { selected: true, hovered: true, focusVisible: true });
const errorBoundary = paintRoles("validationDanger", { validationSurface: selectedFocused.roles.background });
const dropHint = resolveUsage("drop", { surface: "surface.content" }, { dragging: true, allowed: true });
assert.equal(selectedFocused.roles.indicator, "accent.indicator");
assert.equal(selectedFocused.focus.indicator, "focus.ring");
assert.equal(errorBoundary.border, "status.dangerBorder");
assert.equal(dropHint.roles.background, "drop.allowedBackground");
for (let n = 1; n <= 6; n++) {
  const roles = paintRoles(`category${n}`);
  assert.equal(roles.foreground, `category.${n}.foreground`);
  assert.equal(roles.background, `category.${n}.background`);
  assert.equal(roles.border, `category.${n}.border`);
}
// 合法但低对比度的作者主题必须能登记，并返回最终色值的警告。
const lowContrast = structuredClone(ink);
lowContrast.themes[0].colors["status.warningForeground"] = lowContrast.themes[0].colors["status.warningBackground"];
const lowResult = validatePackage(lowContrast.manifest, lowContrast.themes);
const warning = lowResult.warnings.find(w => w.id === "status.warningForeground.on.status.warningBackground");
assert.equal(warning.actualRatio, 1);
assert.equal(warning.foreground, "#352B1E");
assert.equal(warning.background, "#352B1E");
assert.equal(lowContrast.themes[0].colors["status.warningForeground"], "#352B1E", "检查不能自动改作者配色");
const duplicateCategory = structuredClone(ink);
duplicateCategory.themes[0].colors["category.1.foreground"] = "#AABBCC";
duplicateCategory.themes[0].colors["category.2.foreground"] = "#aabbccFF";
assert(validatePackage(duplicateCategory.manifest, duplicateCategory.themes).warnings.some(w => w.kind === "distinction" && w.roles.includes("category.1.foreground") && w.roles.includes("category.2.foreground")), "分类重复检查应忽略大小写及 FF 后缀");

let rejected = 0;
function reject(label, operation, expected) {
  assert.throws(operation, expected, label);
  rejected++;
}
function badPackage(label, edit, expected) {
  const candidate = structuredClone(ink);
  edit(candidate);
  reject(label, () => validatePackage(candidate.manifest, candidate.themes), expected);
}
badPackage("未知颜色", (data) => data.themes[0].colors["text.typo"] = "#FFFFFF", /additionalProperties/);
badPackage("错误色值", (data) => data.themes[0].colors["text.primary"] = "#FFF", /pattern/);
badPackage("不透明角色透明色", (data) => data.themes[0].colors["text.primary"] = "#FFFFFF80", /pattern/);
badPackage("CSS 颜色函数", (data) => data.themes[0].colors["text.primary"] = "rgb(1,2,3)", /pattern/);
badPackage("作者引用其他颜色", (data) => data.themes[0].colors["text.primary"] = { ref: "text.secondary" }, /type/);
badPackage("system 不属于主题类型", (data) => data.themes[0].type = "system", /enum/);
badPackage("新文件格式", (data) => data.themes[0].schemaVersion = 2, /const/);
badPackage("缺少颜色表", (data) => delete data.themes[0].colors, /missing colors/);
badPackage("路径穿越", (data) => data.manifest.contributes.themes[0].path = "../ink-dark.theme.json", /pattern/);
badPackage("路径反斜杠", (data) => data.manifest.contributes.themes[0].path = "themes\\ink-dark.theme.json", /pattern/);
badPackage("主题不属于包", (data) => data.themes[0].id = "other.ink.dark", /不属于/);
badPackage("发行者不一致", (data) => data.manifest.publisher = "other", /发行者/);
badPackage("版本格式", (data) => data.manifest.version = "1.0", /pattern/);
badPackage("倒置版本区间", (data) => data.manifest.compatibility.themeStandard.min = "2.0.0", /上下界/);
badPackage("宿主标准不兼容", (data) => data.manifest.compatibility.themeStandard.min = "1.1.0", /不兼容/);
badPackage("宿主应用不兼容", (data) => data.manifest.compatibility.lodestory.min = "0.1.1", /不兼容/);
badPackage("重复路径", (data) => { data.manifest.contributes.themes.push(data.manifest.contributes.themes[0]); data.themes.push(data.themes[0]); }, /uniqueItems/);
badPackage("重复主题 ID", (data) => { data.manifest.contributes.themes.push({ path: "second.theme.json" }); data.themes.push(data.themes[0]); }, /ID 重复/);
badPackage("空白展示名称", (data) => data.themes[0].name = "   ", /pattern/);
badPackage("未声明可执行入口", (data) => data.manifest.entry = "plugin.js", /additionalProperties/);
for (const role of ["editor.background", "tree.foreground", "tabs.activeBackground", "button.primaryBackground", "input.foreground", "menu.background", "dialog.scrim", "navigation.background", "activityBar.background", "toolbar.background", "titleBar.background", "statusBar.background", "panel.background", "plugin.custom.background", "surface.workspace"]) {
  badPackage(`禁止组件或旧稿专属角色 ${role}`, (data) => data.themes[0].colors[role] = "#FFFFFF", /additionalProperties/);
}
for (const field of ["paintSets", "contexts", "stateRules", "usageRules", "contrastPairs", "distinctionChecks", "components"]) {
  badPackage(`禁止作者覆盖 ${field}`, (data) => data.themes[0][field] = {}, /additionalProperties/);
}
badPackage("保留命名空间", data => {
  data.manifest.publisher = "lodestory";
  data.manifest.id = "lodestory.ink";
  data.themes[0].id = "lodestory.ink.dark";
}, /保留/);
reject("版本命中但未实现标准", () => validatePackage(ink.manifest, ink.themes, false, { appVersion: "0.1.0", themeStandardVersion: null }), /未声明/);
reject("重复 JSON 字段", () => parseJson('{"id":"first","\\u0069d":"second"}'), /重复 JSON/);
reject("悬空缺省引用", () => { const data = structuredClone(registry); data.colors[0].defaults.dark = { ref: "missing.color" }; checkRegistry(data); }, /不存在/);
reject("循环缺省引用", () => { const data = structuredClone(registry); data.colors[0].defaults.dark = { ref: data.colors[0].id }; checkRegistry(data); }, /引用环/);
reject("搭配中写色值", () => { const data = structuredClone(registry); data.paintSets.hover.foreground = "#FFFFFF"; checkRegistry(data); }, /搭配引用不存在/);
reject("危险操作借主操作前景", () => { const data = structuredClone(registry); data.paintSets.dangerRest.foreground = "action.foreground"; checkRegistry(data); }, /未登记对比关系/);
reject("中性内容借实色操作前景", () => resolvePaint("neutral", { surface: "surface.content", foreground: "text.onAction" }), /角色不允许/);
reject("上下文直接写色值", () => resolvePaint("neutral", { surface: "#FFFFFF" }), /角色不允许/);
reject("没有实际承载面", () => resolvePaint("neutral", {}), /必须指定/);
reject("按组件身份取色", () => resolvePaint("editor", context), /未知视觉用途/);
reject("状态布尔值错误", () => resolvePaint("neutral", context, { hovered: "true" }), /布尔值/);
reject("反色背景不能配普通文字", () => resolvePaint("neutral", { surface: "surface.inverse" }), /角色不允许/);
reject("反色面不能用普通焦点环", () => paintRoles("focusExtended", { adjacentSurface: "surface.inverse" }), /角色不允许/);
reject("状态填充不能混用普通链接", () => resolveUsage("link", { surface: "status.warningBackground" }), /角色不允许/);
reject("反色面不能直接叠加校验边界", () => paintRoles("validationDanger", { validationSurface: "surface.inverse" }), /角色不允许/);
reject("新增状态不能拼写错误", () => resolveUsage("drop", context, { allow: true }), /未知扩展状态/);
reject("新增状态必须为布尔值", () => resolveUsage("link", context, { visited: "yes" }), /布尔值/);
reject("漏登记扩展搭配", () => { const data = structuredClone(registry); data.contrastPairs = data.contrastPairs.filter(p => p.id !== "status.warningForeground.on.status.warningBackground"); checkRegistry(data); }, /未登记对比关系/);
reject("文字阈值不能降为边界阈值", () => { const data = structuredClone(registry); data.contrastPairs.find(p => p.id === "status.warningForeground.on.status.warningBackground").minRatio = 3; checkRegistry(data); }, /对比目标错误/);
reject("扩展优先级不能引用不存在组合", () => { const data = structuredClone(registry); data.usageRules.drop.priority[0].paint = "missingPaint"; checkRegistry(data); }, /扩展组合不存在/);
reject("分类不能借用其他槽前景", () => { const data = structuredClone(registry); data.paintSets.category1.foreground = "category.2.foreground"; checkRegistry(data); }, /未登记对比关系/);
reject("分类检查必须引用已登记颜色", () => { const data = structuredClone(registry); data.distinctionChecks[0].roles.push("category.7.foreground"); checkRegistry(data); }, /辨识检查引用不存在/);
for (const role of ["status.warningBackground", "highlight.activeBackground", "drop.allowedBorder", "link.visitedForeground", "surface.inverse", "category.1.background"]) {
  badPackage(`新增不透明角色 ${role}`, data => data.themes[0].colors[role] = "#FFFFFF80", /pattern/);
}
badPackage("超出六个分类槽", data => data.themes[0].colors["category.7.foreground"] = "#FFFFFF", /additionalProperties/);
badPackage("非通用组件高亮", data => data.themes[0].colors["editor.searchMatchBackground"] = "#FFFFFF", /additionalProperties/);

const inkWarnings = collectWarnings(partial);
assert.deepEqual(inkWarnings, [], "随标准交付的墨色示例应通过静态检查，其他作者主题仍允许警告");
const requiredPairs = registry.contrastPairs.filter((pair) => pair.minRatio !== null).length;
console.log(`核验通过：${registry.colors.length} 个通用角色、${Object.keys(registry.paintSets).length} 套引用组合、${registry.contrastPairs.length} 组搭配关系、1 个作者示例包、2 套实际内置主题。`);
console.log(`原配色 CSS 基线比对 ${compared} 项通过；两套内置主题共 ${requiredPairs * 2} 个必要对比组合达标；${vectors.length} 个状态样例、${stateCases} 个基础状态组合和 ${extendedCases} 个扩展状态组合通过；${rejected} 个错误输入被拒绝。`);
console.log("低对比度仅警告、分类重复归一化警告、缺省继承与组合叠加检查通过。");
console.log(`墨色示例可读性警告：${inkWarnings.length} 项${inkWarnings.length ? "（" + inkWarnings.map((pair) => pair.id).join("、") + "）" : ""}。`);
