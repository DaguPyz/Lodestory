import type {EditorCompletionCandidate} from "@lodestory/sdk/body-editor";
import type {AssetCompletionMessage, AssetCompletionReply, AssetTextHighlight} from "./assetCompletionProtocol";

let names: string[] = [];
let details = new Map<string, string>();
let maxNameLength = 0;
type NameNode = {children: Map<string, NameNode>; match?: Pick<AssetTextHighlight, "color" | "assetIds">};
let nameRoot: NameNode = {children: new Map()};

function buildIndex({assets, types}: Extract<AssetCompletionMessage, {kind: "index"}>) {
  const typeNames = new Map(types.map(type => [type.id, type.name]));
  const namesToTypes = new Map<string, Set<string>>();
  const colors = new Map<string, string | undefined>();
  const idsByName = new Map<string, string[]>();
  maxNameLength = 0;
  for (const {id, name, typeId, color} of assets) {
    if (!name || /[\r\n]/u.test(name)) continue;
    const labels = namesToTypes.get(name) ?? new Set();
    labels.add((typeId && typeNames.get(typeId)) || "未分类");
    namesToTypes.set(name, labels);
    // Identical names with conflicting colors are visually ambiguous.
    colors.set(name, colors.has(name) && colors.get(name) !== color ? undefined : color);
    const ids = idsByName.get(name) ?? [];
    ids.push(id);
    idsByName.set(name, ids);
    maxNameLength = Math.max(maxNameLength, [...name].length);
  }
  names = [...namesToTypes.keys()].sort();
  details = new Map([...namesToTypes].map(([name, labels]) => [name, [...labels].sort().join(" / ")]));
  nameRoot = {children: new Map()};
  for (const name of names) {
    let node = nameRoot;
    for (let i = 0; i < name.length; i++) {
      let child = node.children.get(name[i]);
      if (!child) { child = {children: new Map()}; node.children.set(name[i], child); }
      node = child;
    }
    node.match = {color: colors.get(name), assetIds: idsByName.get(name)!.sort()};
  }
}

function lowerBound(prefix: string) {
  let low = 0, high = names.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (names[middle] < prefix) low = middle + 1;
    else high = middle;
  }
  return low;
}

function query(textBefore: string): EditorCompletionCandidate[] {
  if (!maxNameLength) return [];
  const characters = [...textBefore].slice(-maxNameLength);
  for (let from = 0; from < characters.length; from++) {
    const match = characters.slice(from).join("");
    let index = lowerBound(match);
    if (!names[index]?.startsWith(match)) continue;
    if (names[index] === match) index++;
    const candidates: EditorCompletionCandidate[] = [];
    while (names[index]?.startsWith(match)) {
      const name = names[index++];
      candidates.push({match, label: name, detail: details.get(name), insertText: name});
    }
    // Once a full name is typed, keep that match instead of starting from its last character.
    return candidates;
  }
  return [];
}

function highlight(text: string): AssetTextHighlight[] {
  const highlights: AssetTextHighlight[] = [];
  for (let from = 0; from < text.length; from++) {
    let node = nameRoot;
    let match: NameNode["match"];
    let to = from;
    for (let index = from; index < text.length; index++) {
      const child = node.children.get(text[index]);
      if (!child) break;
      node = child;
      if (node.match) { match = node.match; to = index + 1; }
    }
    if (!match) continue;
    highlights.push({from, to, ...match});
    from = to - 1;
  }
  return highlights;
}

self.addEventListener("message", (event: MessageEvent<AssetCompletionMessage>) => {
  const message = event.data;
  let reply: AssetCompletionReply;
  if (message.kind === "index") {
    buildIndex(message);
    reply = {kind: "indexed"};
  } else if (message.kind === "query") {
    reply = {kind: "candidates", candidates: query(message.text)};
  } else {
    reply = {kind: "highlights", highlights: highlight(message.text)};
  }
  self.postMessage(reply);
});
