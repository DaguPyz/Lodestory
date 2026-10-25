import type {CSSProperties} from "react";

// These are user-selectable content colors, independent of the application theme.
export const ASSET_COLOR_PRESETS = [
  {name: "灰", value: "#e9e7e3"},
  {name: "棕", value: "#ead9c8"},
  {name: "橙", value: "#f5d8bc"},
  {name: "黄", value: "#f3e7b3"},
  {name: "绿", value: "#d6e5cf"},
  {name: "青", value: "#cfe5e3"},
  {name: "蓝", value: "#d8e5f2"},
  {name: "紫", value: "#e6dcf0"},
  {name: "粉", value: "#f0dce4"},
  {name: "红", value: "#eed5d2"},
] as const;

export function isAssetColor(value: string | null | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function channels(color: string) {
  return [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
}

function luminance(color: string) {
  const [red, green, blue] = channels(color).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function mix(background: string, foreground: string, amount: number) {
  const front = channels(foreground);
  return `#${channels(background).map((channel, index) =>
    Math.round(channel * (1 - amount) + front[index] * amount).toString(16).padStart(2, "0")).join("")}`;
}

/** Preserve the chosen background exactly, adapting only the content painted over it. */
export function assetCardColorStyle(color: string | null | undefined): CSSProperties | undefined {
  if (!isAssetColor(color)) return undefined;
  const foreground = contrast(color, "#000000") >= contrast(color, "#ffffff") ? "#000000" : "#ffffff";
  const surfaceDirection = foreground === "#000000" ? "#ffffff" : "#000000";
  let secondary = foreground;
  for (const amount of [0.72, 0.8, 0.88, 0.94]) {
    const candidate = mix(color, foreground, amount);
    if (contrast(color, candidate) >= 4.5) { secondary = candidate; break; }
  }
  return {
    "--asset-card-background": color,
    "--asset-card-foreground": foreground,
    "--asset-card-secondary": secondary,
    "--asset-card-badge-background": mix(color, surfaceDirection, 0.08),
    "--asset-card-hover": mix(color, surfaceDirection, 0.06),
    "--asset-card-pressed": mix(color, surfaceDirection, 0.12),
  } as CSSProperties;
}
