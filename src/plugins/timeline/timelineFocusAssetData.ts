import type {AssetCatalogSnapshot} from "@lodestory/sdk/asset-catalog";
import type {AssetRelation} from "@lodestory/sdk/asset-relations";

export type FocusAsset = Readonly<{id: string; name: string; detail: string; title: string; known: boolean}>;
type FocusGroup = {id: string; label: string; color: string; rank: number; items: FocusAsset[]};

const preferredGroups = [
  {label: "人物", color: "var(--timeline-focus-gold)"},
  {label: "势力", color: "var(--ui-category-2-foreground)"},
  {label: "地点", color: "var(--ui-category-1-foreground)"},
];
const categoryColors = [3, 4, 5, 6, 1, 2].map(index => `var(--ui-category-${index}-foreground)`);

export function groupFocusAssets(ids: readonly string[], snapshot: AssetCatalogSnapshot | null) {
  if (!ids.length) return [];
  const assets = new Map(snapshot?.assets.map(asset => [asset.id, asset]));
  const types = new Map(snapshot?.types.map((type, index) => [type.id, {type, index}]));
  const available = Boolean(snapshot?.loaded && !snapshot.blocked && !snapshot.error);
  const unavailable = available ? "失效关联" : "待确认关联";
  const groups = new Map<string, FocusGroup>();
  for (const id of ids) {
    const asset = assets.get(id);
    const template = asset?.typeId ? types.get(asset.typeId) : undefined;
    const type = template?.type;
    const label = type?.name ?? (asset ? (asset.typeId ? "未知分类" : "未分类") : unavailable);
    const groupId = type?.id ?? label;
    let group = groups.get(groupId);
    if (!group) {
      const sector = preferredGroups.findIndex(group => group.label === type?.name);
      const color = preferredGroups[sector]?.color
        ?? (template ? categoryColors[template.index % categoryColors.length] : "var(--ui-text-muted)");
      group = {id: groupId, label, color,
        rank: sector >= 0 ? sector : preferredGroups.length + (template?.index ?? types.size), items: []};
      groups.set(groupId, group);
    }
    const name = asset?.name ?? (available ? "资产不可用" : "资产待确认");
    const detail = !asset ? id.slice(0, 8) : type?.status === "archived" ? `${label}（已归档）` : label;
    group.items.push({id, name, detail, known: Boolean(asset),
      title: asset?.description ? `${name} · ${asset.description}` : asset ? name : id});
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank);
}

/** Join the labels for each neighboring object without inferring a direction. */
export function relationLabelsByAsset(assetId: string, relations: readonly AssetRelation[]): ReadonlyMap<string, readonly string[]> {
  const labels = new Map<string, Set<string>>();
  for (const {assets: [first, second], label} of relations) {
    const peer = first.assetsId === assetId ? second : second.assetsId === assetId ? first : null;
    if (!peer || peer.assetsId === assetId) continue;
    let entries = labels.get(peer.assetsId);
    if (!entries) {
      entries = new Set();
      labels.set(peer.assetsId, entries);
    }
    entries.add(label);
  }
  return new Map([...labels].map(([id, entries]) => [id, [...entries]]));
}
