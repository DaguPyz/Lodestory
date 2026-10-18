import {invoke, isTauri} from "@tauri-apps/api/core";

/** Keeps font enumeration and its cache inside one rich-text plugin instance. */
export function createSystemFontLoader(): () => Promise<readonly string[]> {
  let cachedFamilies: readonly string[] | undefined;
  let inFlight: Promise<readonly string[]> | undefined;

  return async () => {
    if (!isTauri()) throw new Error("系统字体列表仅能在桌面应用中读取。");
    if (cachedFamilies) return cachedFamilies;
    if (inFlight) return inFlight;

    const request = invoke<unknown>("list_system_font_families").then(result => {
      if (!Array.isArray(result)) throw new Error("系统返回的字体列表格式无效。");
      const names = new Map<string, string>();
      for (const value of result) {
        if (typeof value !== "string" || !isSystemFamilyName(value)) continue;
        const folded = value.toLowerCase();
        if (!names.has(folded)) names.set(folded, value);
      }
      cachedFamilies = Object.freeze([...names.values()].sort(compareFamilyNames));
      return cachedFamilies;
    });
    inFlight = request;
    try {
      return await request;
    } finally {
      if (inFlight === request) inFlight = undefined;
    }
  };
}

function compareFamilyNames(left: string, right: string): number {
  const leftFolded = left.toLowerCase();
  const rightFolded = right.toLowerCase();
  if (leftFolded < rightFolded) return -1;
  if (leftFolded > rightFolded) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSystemFamilyName(name: string): boolean {
  return name.trim().length > 0 && Array.from(name).length <= 1024 && !/\p{Cc}/u.test(name);
}
