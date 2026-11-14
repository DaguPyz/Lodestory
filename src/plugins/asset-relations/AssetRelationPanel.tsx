import {useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent} from "react";
import {Popover} from "@base-ui/react/popover";
import type {AssetCatalogSnapshot} from "@lodestory/sdk/asset-catalog";
import type {AssetEditorPanelProps} from "@lodestory/sdk/asset-editor";
import type {AssetRelation} from "@lodestory/sdk/asset-relations";
import {Button, Dialog, DialogActions, Icon, IconButton, SearchableSelect, TextField, useInteractionRef} from "@lodestory/ui";
import {relationKey} from "./assetRelationStore";
import type {AssetRelationSession} from "./assetRelationsPlugin";

const UNCATEGORIZED = "uncategorized";
const EMPTY_CATALOG: AssetCatalogSnapshot = Object.freeze({types: [], assets: [], loaded: false, loading: false, error: null, blocked: false});
const emptySnapshot = () => EMPTY_CATALOG;
const emptySubscribe = () => () => {};

type RelationDraft = {
  previous?: AssetRelation;
  label: string;
  category: string | null;
  peerId: string | null;
  ownTag: string;
  peerTag: string;
};
const EMPTY_DRAFT: RelationDraft = {label: "", category: null, peerId: null, ownTag: "", peerTag: ""};

function endpoints(relation: AssetRelation, assetId: string) {
  const [first, second] = relation.assets;
  return first.assetsId === assetId ? [first, second] as const : [second, first] as const;
}

function RelationTags({currentName, peerName, ownTag, peerTag, disabled, onChange}: {
  currentName: string;
  peerName: string;
  ownTag: string;
  peerTag: string;
  disabled: boolean;
  onChange(patch: Partial<Pick<RelationDraft, "ownTag" | "peerTag">>): void;
}) {
  const [open, setOpen] = useState(false);
  const [density, setDensity] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = open && !disabled;
  const interactionRef = useInteractionRef<HTMLDivElement>(visible, "popover");
  const count = Number(Boolean(ownTag.trim())) + Number(Boolean(peerTag.trim()));
  const buttonLabel = count ? `标签（${count}）` : "添加标签";

  useLayoutEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return <Popover.Root open={visible} onOpenChange={next => {
    if (next) setDensity(trigger.current?.closest<HTMLElement>("[data-ui-density]")?.dataset.uiDensity);
    setOpen(next);
  }}>
    <Popover.Trigger ref={trigger} disabled={disabled} render={<Button type="button" variant="ghost"/>}>
      <Icon name={count ? "chevronDown" : "plus"} size="small" aria-hidden="true"/>
      {buttonLabel}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner data-ui-density={density} className="asset-relations-tags-positioner"
        align="start" sideOffset={4} collisionPadding={8}>
        <Popover.Popup ref={interactionRef} className="asset-relations-tags-popup">
          <div className="asset-relations-tags-heading">
            <Popover.Title>关系标签</Popover.Title><span>选填</span>
          </div>
          <label className="asset-relations-label">
            <span>{currentName}的标签</span>
            <TextField value={ownTag} disabled={disabled} autoComplete="off" onChange={event => onChange({ownTag: event.currentTarget.value})}/>
          </label>
          <label className="asset-relations-label">
            <span>{peerName}的标签</span>
            <TextField value={peerTag} disabled={disabled} autoComplete="off" onChange={event => onChange({peerTag: event.currentTarget.value})}/>
          </label>
          <Popover.Close render={<Button type="button" variant="secondary"/>}>完成</Popover.Close>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

function RelationEditor({resource, assetId, active, onEditingChange}: AssetEditorPanelProps & {resource: AssetRelationSession}) {
  const {store, catalog, editing} = resource;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const directory = useSyncExternalStore(catalog?.subscribe ?? emptySubscribe,
    catalog?.getSnapshot ?? emptySnapshot, catalog?.getSnapshot ?? emptySnapshot);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [removing, setRemoving] = useState<AssetRelation | null>(null);
  const token = useRef(Symbol("asset-relation-draft"));
  const labelInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const labelId = useId();
  const categoryLabelId = useId();
  const peerLabelId = useId();
  const canInteract = active && !snapshot.loading && !snapshot.saving;
  const catalogReady = directory.loaded && !directory.loading && !directory.blocked;
  const formDisabled = !canInteract || !snapshot.loaded || !catalogReady || snapshot.pending || removing !== null;
  const hasDraft = Boolean(draft.previous || draft.label || draft.category || draft.peerId || draft.ownTag || draft.peerTag);
  const hasWork = hasDraft || removing !== null || snapshot.saving || snapshot.pending;
  const assetsById = useMemo(() => new Map(directory.assets.map(asset => [asset.id, asset])), [directory.assets]);
  const activeTypes = useMemo(() => new Map(directory.types.filter(type => type.status === "active")
    .map(type => [type.id, type.name])), [directory.types]);
  const relations = store.getRelations(assetId);
  const currentName = assetsById.get(assetId)?.name ?? "当前对象";
  const peerExists = Boolean(draft.peerId && assetsById.has(draft.peerId));

  function assetName(id: string) {
    return assetsById.get(id)?.name ?? `${catalogReady ? "对象已缺失" : "对象暂不可用"}（${id.slice(0, 8)}）`;
  }

  const categoryOptions = useMemo(() => [...activeTypes].map(([value, label]) => ({value, label}))
    .concat({value: UNCATEGORIZED, label: "未分类"}), [activeTypes]);
  const category = draft.category === null || activeTypes.has(draft.category) ? draft.category : UNCATEGORIZED;
  const peerOptions = useMemo(() => {
    if (!category) return [];
    const nameCounts = new Map<string, number>();
    const candidates = directory.assets.filter(asset => asset.id !== assetId && (category === UNCATEGORIZED
      ? !asset.typeId || !activeTypes.has(asset.typeId) : asset.typeId === category));
    for (const {name} of candidates) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    return candidates.map(asset => ({value: asset.id, searchText: asset.description,
      label: (nameCounts.get(asset.name) ?? 0) > 1
        ? `${asset.name} · ${asset.description ? `${asset.description} · ` : ""}${asset.id.slice(-8)}` : asset.name}));
  }, [directory.assets, activeTypes, category, assetId]);

  useLayoutEffect(() => {
    if (hasWork) editing.add(token.current); else editing.delete(token.current);
    onEditingChange(hasWork);
  }, [editing, hasWork, onEditingChange]);
  useLayoutEffect(() => {
    const guard = token.current;
    return () => { editing.delete(guard); };
  }, [editing]);
  function updateDraft(patch: Partial<RelationDraft>) {
    store.clearError();
    setDraft(current => ({...current, ...patch}));
  }

  function startEditing(relation: AssetRelation) {
    if (formDisabled) return;
    const [own, peer] = endpoints(relation, assetId);
    const peerType = assetsById.get(peer.assetsId)?.typeId;
    store.clearError();
    setDraft({previous: relation, label: relation.label, category: assetsById.has(peer.assetsId) ? peerType ?? UNCATEGORIZED : null,
      peerId: peer.assetsId, ownTag: own.tag ?? "", peerTag: peer.tag ?? ""});
    labelInput.current?.focus();
  }

  function finishEditing(focusPanel = false) {
    setDraft(EMPTY_DRAFT);
    setRemoving(null);
    (focusPanel ? heading.current : labelInput.current)?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (formDisabled || !draft.peerId || !assetsById.has(draft.peerId) || !draft.label.trim()) return;
    const saved = await store.save({
      label: draft.label,
      assets: [{assetsId: assetId, tag: draft.ownTag}, {assetsId: draft.peerId, tag: draft.peerTag}],
    }, draft.previous);
    if (saved) finishEditing(true);
  }

  async function removeRelation() {
    if (!canInteract || !removing) return;
    const saved = snapshot.pending ? await store.retrySave() : await store.remove(removing);
    if (saved) finishEditing(true);
  }

  async function retrySave() {
    if (canInteract && await store.retrySave()) finishEditing(true);
  }

  return <section className="asset-relations-panel" aria-labelledby={headingId}>
    <h2 ref={heading} id={headingId} tabIndex={-1}>资产关系</h2>
    <form className="asset-relations-form" onSubmit={submit} aria-busy={snapshot.saving || undefined}>
      <div className="asset-relations-fields">
        <label className="asset-relations-label" htmlFor={labelId}>
          <span>关系描述</span>
          <TextField id={labelId} ref={labelInput} value={draft.label} placeholder="填写关系" autoComplete="off"
            disabled={formDisabled} required onChange={event => updateDraft({label: event.currentTarget.value})}/>
        </label>
        <div className="asset-relations-label">
          <span id={categoryLabelId}>资产分类</span>
          <SearchableSelect aria-labelledby={categoryLabelId} searchLabel="搜索分类"
            value={category} options={categoryOptions} placeholder="选分类"
            disabled={formDisabled} onValueChange={next => updateDraft({category: next, peerId: null, peerTag: ""})}/>
        </div>
        <div className="asset-relations-label">
          <span id={peerLabelId}>关联对象</span>
          <SearchableSelect aria-labelledby={peerLabelId} searchLabel="搜索对象" value={peerExists ? draft.peerId : null}
            options={peerOptions} placeholder={category && !peerOptions.length ? "无对象" : "选对象"}
            disabled={formDisabled || !peerOptions.length} onValueChange={peerId => updateDraft({peerId, peerTag: ""})}/>
        </div>
      </div>
      <div className="asset-relations-actions">
        {!snapshot.loaded && !snapshot.loading ? <Button type="button" variant="secondary" disabled={!canInteract}
          onClick={() => void store.load()}>重试读取</Button>
          : snapshot.pending && !removing ? <Button type="button" variant="secondary" disabled={!canInteract}
            onClick={() => void retrySave()}>{snapshot.saving ? "正在保存…" : "重试保存关系"}</Button>
          : <Button type="submit" variant="secondary" disabled={formDisabled || !draft.label.trim() || !peerExists}>
            {snapshot.saving ? "正在保存…" : draft.previous ? "保存关系" : "添加关系"}
          </Button>}
      </div>
      <div className="asset-relations-options">
        <RelationTags currentName={currentName} peerName={draft.peerId ? assetName(draft.peerId) : "关联对象"}
          ownTag={draft.ownTag} peerTag={draft.peerTag} disabled={formDisabled || !peerExists} onChange={updateDraft}/>
        {hasDraft && !snapshot.pending && <Button type="button" variant="ghost" aria-label="取消关系编辑"
          disabled={!canInteract || removing !== null} onClick={() => { store.clearError(); finishEditing(); }}>取消</Button>}
      </div>
      {snapshot.error && !removing && <p className="asset-relations-error" role="alert">{snapshot.error}</p>}
      {!snapshot.error && !snapshot.loading && !catalogReady && <p className="asset-relations-message" role="status">资产目录暂不可用。</p>}
      {snapshot.loading && <p className="asset-relations-message" role="status">正在读取资产关系…</p>}
    </form>
    {snapshot.loaded && (relations.length ? <ul className="asset-relations-list" aria-label="已添加的关系">
      {relations.map(relation => {
        const [own, peer] = endpoints(relation, assetId);
        const peerName = assetName(peer.assetsId);
        return <li key={relationKey(relation)}>
          <div className="asset-relations-row">
            <span className="asset-relations-endpoint">
              <strong>{currentName}</strong>{own.tag && <span className="asset-relations-tag">（{own.tag}）</span>}
            </span>{" "}
            <span className="asset-relations-description">{relation.label}</span>{" "}
            <span className="asset-relations-endpoint" title={assetsById.get(peer.assetsId)?.description || peerName}>
              <strong>{peerName}</strong>{peer.tag && <span className="asset-relations-tag">（{peer.tag}）</span>}
            </span>
          </div>
          <div className="asset-relations-row-actions">
            <IconButton label={`编辑与${peerName}的关系「${relation.label}」`} disabled={formDisabled || hasDraft}
              onClick={() => startEditing(relation)}><Icon name="pencil" size="small"/></IconButton>
            <IconButton label={`删除与${peerName}的关系「${relation.label}」`}
              disabled={!canInteract || hasWork} onClick={() => {store.clearError(); setRemoving(relation);}}><Icon name="trash" size="small"/></IconButton>
          </div>
        </li>;
      })}
    </ul> : <p className="asset-relations-empty">还没有关联的对象。</p>)}
    <Dialog open={removing !== null && active} onOpenChange={open => {if (!open && !snapshot.saving) setRemoving(null);}}
      title="删除关系" description={`从两个对象中删除「${removing?.label ?? ""}」这条关系。`} size="narrow"
      busy={snapshot.saving} initialFocus={deleteCancel} finalFocus={heading}>
      {snapshot.error && <p className="asset-relations-error" role="alert">{snapshot.error}</p>}
      <DialogActions>
        <Button variant="secondary" ref={deleteCancel} disabled={snapshot.saving} onClick={() => setRemoving(null)}>
          {snapshot.pending ? "关闭" : "取消"}
        </Button>
        <Button variant="danger" disabled={!canInteract} onClick={() => void removeRelation()}>
          {snapshot.saving ? "正在保存…" : snapshot.pending ? "重试保存" : "删除关系"}
        </Button>
      </DialogActions>
    </Dialog>
  </section>;
}

export function AssetRelationPanel({resource, ...props}: AssetEditorPanelProps & {resource?: AssetRelationSession}) {
  return resource ? <RelationEditor key={props.assetId} resource={resource} {...props}/>
    : <p className="asset-relations-message" role="status">资产关系暂不可用。</p>;
}
