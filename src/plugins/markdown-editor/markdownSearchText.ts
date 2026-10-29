import {fromMarkdown} from "mdast-util-from-markdown";
import {gfm} from "micromark-extension-gfm";
import {gfmFromMarkdown} from "mdast-util-gfm";

type SearchNode = {type: string; value?: string; children?: readonly SearchNode[]};

/** Project only readable Markdown content; markup and link destinations are not prose. */
export function markdownSearchText(markdown: string): string {
  const tree = fromMarkdown(markdown, {extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()]}) as SearchNode;
  const blocks: string[] = [];
  function inline(node: SearchNode): string {
    if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
    if (node.type === "break") return "\n";
    if (node.type === "html" || node.type === "image" || node.type === "imageReference") return "";
    return (node.children ?? []).map(inline).join("");
  }
  function visit(node: SearchNode) {
    if (node.type === "definition" || node.type === "html" || node.type === "thematicBreak") return;
    if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
      blocks.push(inline(node));
      return;
    }
    if (node.type === "code") { blocks.push(node.value ?? ""); return; }
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  return blocks.join("\n");
}
