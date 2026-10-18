import Quill, {Parchment} from "quill";
import {isRichTextSize} from "./richDeltaFormat";
import {isRichFontFamily, parseFontFamily, quoteFontFamily} from "./richTextFormatting";

/**
 * Builds a registry owned by one editor instance. Nothing is added to Quill's
 * process-wide registry, so separate rich-text editors can use different data.
 */
export function createRichTextRegistry(): Parchment.Registry {
  const registry = new Parchment.Registry();
  // Use Quill's six core formats. Embed base classes are exported for
  // subclassing and rejected by Parchment.Registry.register().
  const coreBlots = [
    "blots/scroll",
    "blots/block",
    "blots/break",
    "blots/cursor",
    "blots/inline",
    "blots/text",
  ];
  const formats = [
    "formats/bold",
    "formats/italic",
    "formats/underline",
    "formats/strike",
    "formats/header",
    "formats/blockquote",
    "formats/link",
    "attributors/style/align",
    "attributors/style/color",
    "attributors/style/background",
  ];

  for (const name of [...coreBlots, ...formats]) {
    registry.register(Quill.import(name) as Parchment.RegistryDefinition);
  }
  const ListItem = Quill.import("formats/list") as Parchment.BlotConstructor & {
    requiredContainer?: Parchment.BlotConstructor;
  };
  if (!ListItem.requiredContainer) throw new Error("Quill list format is missing its required container blot.");
  registry.register(ListItem.requiredContainer, ListItem);
  registry.register(new RichFontStyleAttributor(), new RichSizeStyleAttributor());
  return registry;
}

class RichFontStyleAttributor extends Parchment.StyleAttributor {
  constructor() {
    super("font", "font-family", {scope: Parchment.Scope.INLINE});
  }

  canAdd(node: HTMLElement, value: unknown): boolean {
    return typeof value === "string"
      && super.canAdd(node, value)
      && isRichFontFamily(unquoteIfEncoded(value));
  }

  add(node: HTMLElement, value: string): boolean {
    if (!isRichFontFamily(value)) return false;
    return super.add(node, quoteFontFamily(value));
  }

  value(node: HTMLElement): string {
    const value = super.value(node);
    const parsed = parseFontFamily(value);
    return parsed && isRichFontFamily(parsed) ? parsed : "";
  }
}

class RichSizeStyleAttributor extends Parchment.StyleAttributor {
  constructor() {
    super("size", "font-size", {scope: Parchment.Scope.INLINE});
  }

  canAdd(node: HTMLElement, value: unknown): boolean {
    return typeof value === "string" && super.canAdd(node, value) && isRichTextSize(value);
  }

  add(node: HTMLElement, value: string): boolean {
    if (!isRichTextSize(value)) return false;
    return super.add(node, value);
  }

  value(node: HTMLElement): string {
    const value = super.value(node);
    return isRichTextSize(value) ? value : "";
  }
}

function unquoteIfEncoded(value: string): string {
  return parseFontFamily(value) ?? value;
}
