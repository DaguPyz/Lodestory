import type {EditorCompletionCandidate} from "@lodestory/sdk/body-editor";
import type {AssetCompletionMessage, AssetCompletionReply} from "./assetCompletionProtocol";

let names: string[] = [];
let details = new Map<string, string>();
let maxNameLength = 0;

function buildIndex({assets, types}: Extract<AssetCompletionMessage, {kind: "index"}>) {
  const typeNames = new Map(types.map(type => [type.id, type.name]));
  const namesToTypes = new Map<string, Set<string>>();
  maxNameLength = 0;
  for (const {name, typeId} of assets) {
    if (!name || /[\r\n]/u.test(name)) continue;
    const labels = namesToTypes.get(name) ?? new Set();
    labels.add((typeId && typeNames.get(typeId)) || "未分类");
    namesToTypes.set(name, labels);
    maxNameLength = Math.max(maxNameLength, [...name].length);
  }
  names = [...namesToTypes.keys()].sort();
  details = new Map([...namesToTypes].map(([name, labels]) => [name, [...labels].sort().join(" / ")]));
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

self.addEventListener("message", (event: MessageEvent<AssetCompletionMessage>) => {
  const message = event.data;
  let reply: AssetCompletionReply;
  if (message.kind === "index") {
    buildIndex(message);
    reply = {kind: "indexed"};
  } else {
    reply = {kind: "candidates", candidates: query(message.textBefore)};
  }
  self.postMessage(reply);
});
