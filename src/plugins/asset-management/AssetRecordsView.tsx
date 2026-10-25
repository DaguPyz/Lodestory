import {useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent} from "react";
import {Button, Dialog, DialogActions, Icon, IconButton, Textarea, TextField} from "@lodestory/ui";
import type {ContextMenuService, MenuEntry} from "@lodestory/sdk/context-menu";
import type {AssetSessionResources} from "./assetManagementPlugin";
import {useAssetProject, type AssetViewProps} from "./AssetManagementView";
import {AssetSchemaForm, type AssetSchemaDraft} from "./AssetSchemaForm";
import {AssetValueFields} from "./AssetValueFields";
import type {AssetFieldDefinition, AssetPropertyValue, AssetRecord} from "./assetSchemaStore";

type AssetDraft = {
  kind: "create" | "edit";
  id: string;
  name: string;
  description: string;
  typeId: string | null;
  values: Record<string, AssetPropertyValue>;
};

type DeleteTarget =
  | {kind: "asset"; id: string; name: string}
  | {kind: "field"; id: string; title: string; assetId: string; assetName: string};

function orderedFields(fields: readonly AssetFieldDefinition[], kind: "type" | "asset", id: string | null) {
  return fields.filter(field => field.status === "active" && field.owner.kind === kind && field.owner.id === id)
    .slice().sort((a, b) => a.order - b.order);
}

function displayedValue(field: AssetFieldDefinition, asset: AssetRecord, assets: readonly AssetRecord[]): string {
  const value = asset.values[field.id];
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return "未填写";
  if (field.valueType === "singleSelect" || field.valueType === "multiSelect") {
    const ids = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string")
      : typeof value === "string" ? [value] : [];
    return ids.map(id => field.config.options?.find(option => option.id === id)?.title ?? "已失效的选项").join("、");
  }
  if (field.valueType === "reference") return typeof value === "string"
    ? assets.find(item => item.id === value)?.name ?? "关联对象不可用" : "关联对象不可用";
  return String(value);
}

function clonePropertyValue(value: AssetPropertyValue): AssetPropertyValue {
  return Array.isArray(value) ? [...value] : value;
}

function RecordsEditor({resource, active, canInteract, onOpenTypes, contextMenus}: {
  resource: AssetSessionResources;
  active: boolean;
  canInteract(): boolean;
  onOpenTypes(): void;
  contextMenus: ContextMenuService;
}) {
  const {store} = resource;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const types = snapshot.types.filter(type => type.status === "active").slice().sort((a, b) => a.order - b.order);
  const activeTypeIds = new Set(types.map(type => type.id));
  const selectedType = types.find(type => type.id === snapshot.selectedTypeId) ?? null;
  const scopeAssets = snapshot.assets.filter(asset => selectedType
    ? asset.typeId === selectedType.id
    : asset.typeId === null || !activeTypeIds.has(asset.typeId));
  const selected = scopeAssets.find(asset => asset.id === snapshot.selectedAssetId) ?? null;
  const [draft, setDraft] = useState<AssetDraft | null>(null);
  const [fieldDraft, setFieldDraft] = useState<AssetSchemaDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "cards">("list");
  const editor = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const fieldInput = useRef<HTMLInputElement>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const token = useRef(Symbol("asset-record-editor"));
  const epoch = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const busy = pending || snapshot.saving;
  const disabled = !active || busy || !snapshot.loaded || snapshot.loading || snapshot.blocked || snapshot.dirty;
  const owner = draft ?? selected;
  const detailTemplateFields = orderedFields(snapshot.fields, "type", owner?.typeId ?? null);
  const customFields = orderedFields(snapshot.fields, "asset", owner?.id ?? null);
  const fields = [...detailTemplateFields, ...customFields];
  const scopeFields = selectedType ? orderedFields(snapshot.fields, "type", selectedType.id) : [];
  const deleting = deleteTarget !== null;
  const deletionApplied = deleteTarget?.kind === "asset"
    ? !snapshot.assets.some(asset => asset.id === deleteTarget.id)
    : deleteTarget?.kind === "field" && !snapshot.fields.some(field => field.id === deleteTarget.id);
  const deletionPendingSave = deletionApplied && snapshot.dirty;

  useLayoutEffect(() => () => {
    epoch.current++;
    resource.editing.delete(token.current);
  }, [resource]);
  useLayoutEffect(() => {
    if (snapshot.selectedAssetId && !selected) store.selectAsset(null);
  }, [selected, snapshot.selectedAssetId, store]);
  useLayoutEffect(() => {
    if (draft && active) nameInput.current?.focus();
  }, [draft?.id, draft?.kind, active]);

  function begin(next: AssetDraft) {
    if (disabled || !canInteract() || resource.editing.size > 0) return;
    resource.editing.add(token.current);
    setDraft(next);
    setError(null);
  }
  function cancel() {
    if (busy) return;
    resource.editing.delete(token.current);
    setDraft(null);
    setFieldDraft(null);
    setDeleteTarget(null);
    setError(null);
  }
  async function run(operation: () => Promise<boolean>, finish = false) {
    if (!activeRef.current || !canInteract() || pending) return;
    if (resource.editing.size > 0 && !resource.editing.has(token.current)) return;
    const operationEpoch = epoch.current;
    setPending(true);
    setError(null);
    try {
      const accepted = await operation();
      if (operationEpoch !== epoch.current) return;
      if (accepted && finish) {
        resource.editing.delete(token.current);
        setDraft(null);
        setFieldDraft(null);
        setDeleteTarget(null);
        editor.current?.focus();
      } else if (!accepted) setError(store.getSnapshot().error ?? "未能保存，请检查内容后重试。");
    } catch (cause) {
      if (operationEpoch === epoch.current) setError(cause instanceof Error ? cause.message : "保存失败，请重试。");
    } finally {
      if (operationEpoch === epoch.current) setPending(false);
    }
  }
  function newAsset() {
    if (!selectedType) return;
    const values: Record<string, AssetPropertyValue> = {};
    for (const field of scopeFields) {
      if (field.defaultValue !== undefined) values[field.id] = clonePropertyValue(field.defaultValue);
    }
    begin({kind: "create", id: crypto.randomUUID(), name: "", description: "", typeId: selectedType.id, values});
  }
  function editAsset(assetId: string | null) {
    const asset = assetFromMenu(assetId);
    if (asset) begin({...asset, kind: "edit", values: {...asset.values}});
  }
  function showAsset(id: string) {
    if (disabled || !scopeAssets.some(asset => asset.id === id) || !canInteract() || resource.editing.size > 0) return;
    if (store.selectAsset(id)) setError(null);
  }
  function returnToList(assetId: string | null) {
    if (assetFromMenu(assetId)) store.selectAsset(null);
  }
  function openTypes(create = false) {
    if (disabled || draft || fieldDraft || deleting || !canInteract() || resource.editing.size > 0) return;
    if (create && !store.requestTypeCreation()) {
      setError(store.getSnapshot().error ?? "暂时无法新建资产模板，请重试。");
      return;
    }
    setError(null);
    onOpenTypes();
  }
  function canUseMenu() {
    const current = store.getSnapshot();
    return activeRef.current && canInteract() && resource.editing.size === 0 && !pending &&
      !current.saving && current.loaded && !current.loading && !current.blocked && !current.dirty &&
      !draft && !fieldDraft && !deleteTarget;
  }
  function assetFromMenu(assetId: string | null) {
    const current = store.getSnapshot();
    if (!canUseMenu() || !assetId || selected?.id !== assetId || current.selectedAssetId !== assetId ||
      current.selectedTypeId !== snapshot.selectedTypeId) return undefined;
    return current.assets.find(asset => asset.id === assetId);
  }
  function removeAssetFromMenu(assetId: string | null) {
    const asset = assetFromMenu(assetId);
    if (asset) confirmAssetRemoval(asset);
  }
  function openSelectedTemplateSettings(menuTypeId: string | null) {
    const current = store.getSnapshot();
    const validSelection = current.types.some(type => type.id === current.selectedTypeId && type.status === "active");
    if (!canUseMenu() || !validSelection || !menuTypeId || menuTypeId !== current.selectedTypeId ||
      !selectedType || selectedType.id !== current.selectedTypeId) return;
    openTypes(false);
  }
  function createObjectFromMenu(menuTypeId: string | null) {
    const current = store.getSnapshot();
    const validSelection = current.types.some(type => type.id === current.selectedTypeId && type.status === "active");
    if (!canUseMenu() || !validSelection || !menuTypeId || menuTypeId !== current.selectedTypeId ||
      !selectedType || selectedType.id !== current.selectedTypeId) return;
    newAsset();
  }
  function createTemplateFromMenu(menuTypeId: string | null) {
    const current = store.getSnapshot();
    const validSelection = current.types.some(type => type.id === current.selectedTypeId && type.status === "active");
    if (!canUseMenu() || menuTypeId !== current.selectedTypeId || validSelection || selectedType) return;
    openTypes(true);
  }
  function switchViewMode(next: "list" | "cards") {
    const current = store.getSnapshot();
    if (!activeRef.current || !canInteract() || pending || current.saving || resource.editing.size > 0) return;
    setViewMode(next);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy || !active || !canInteract()) return;
    if (!event.currentTarget.reportValidity()) return;
    const name = draft.name.trim();
    if ([...name].length < 1 || [...name].length > 60) { setError("对象名称需要填写 1–60 个字符。"); nameInput.current?.focus(); return; }
    if ([...draft.description].length > 200) { setError("对象简介不能超过 200 个字符。"); return; }
    const values = Object.fromEntries(fields.filter(field => Object.prototype.hasOwnProperty.call(draft.values, field.id)).map(field => [field.id, draft.values[field.id]]));
    const input = {name, description: draft.description, values};
    void run(async () => {
      if (store.getSnapshot().dirty && !await store.retry()) return false;
      return draft.kind === "create"
        ? store.createAsset({...input, id: draft.id, typeId: draft.typeId})
        : store.updateAsset(draft.id, input);
    }, true);
  }
  function openField(field?: AssetFieldDefinition) {
    if (!selected || disabled || !canInteract() || resource.editing.size > 0) return;
    resource.editing.add(token.current);
    setError(null);
    setFieldDraft({kind: field ? "renameField" : "newField", id: field?.id ?? crypto.randomUUID(),
      ownerKind: "asset", typeId: selected.id, title: field?.title ?? "", valueType: field?.valueType ?? "text",
      options: [], targetTypeId: null, defaultText: "", defaultOptions: []});
  }
  function confirmAssetRemoval(asset: AssetRecord) {
    if (disabled || !canInteract() || resource.editing.size > 0) return;
    resource.editing.add(token.current);
    setError(null);
    setDeleteTarget({kind: "asset", id: asset.id, name: asset.name});
  }
  function confirmFieldRemoval(field: AssetFieldDefinition) {
    if (!selected || disabled || !canInteract() || resource.editing.size > 0) return;
    if (field.owner.kind !== "asset" || field.owner.id !== selected.id) return;
    resource.editing.add(token.current);
    setError(null);
    setDeleteTarget({kind: "field", id: field.id, title: field.title, assetId: selected.id, assetName: selected.name});
  }
  function removeConfirmed() {
    if (!deleteTarget || busy || !active || !canInteract()) return;
    const target = deleteTarget;
    void run(() => deletionPendingSave ? store.retry()
      : target.kind === "asset" ? store.removeAsset(target.id) : store.removeAssetField(target.assetId, target.id), true);
  }
  function fieldSection(title: string, definitions: readonly AssetFieldDefinition[], custom = false) {
    return <section className="asset-properties-section" aria-label={title}>
      <div className="asset-fields-heading"><h2>{title}</h2>
        {custom && selected && !draft && <Button disabled={disabled || fieldDraft !== null || deleting}
          onClick={() => openField()}><Icon name="plus" size="small"/>添加专属属性</Button>}
      </div>
      {definitions.length > 0 ? draft
        ? <AssetValueFields fields={definitions} assets={snapshot.assets} values={draft.values} disabled={disabled}
          onChange={(id, value) => {setDraft({...draft, values: {...draft.values, [id]: value}}); setError(null);}}/>
        : selected && <dl className="asset-property-values">{definitions.map(field => <div key={field.id}>
          <dt>{custom ? <Button variant="ghost" disabled={disabled || fieldDraft !== null || deleting}
            aria-label={`修改“${field.title}”的属性标题`} onClick={() => openField(field)}>{field.title}</Button> : field.title}</dt>
          <dd className={custom ? "asset-property-content" : undefined}
            data-empty={selected.values[field.id] === undefined || selected.values[field.id] === null || selected.values[field.id] === "" || undefined}>
            <span>{displayedValue(field, selected, snapshot.assets)}</span>
            {custom && <Button variant="ghost" disabled={disabled || fieldDraft !== null || deleting}
              aria-label={`删除“${field.title}”的专属属性`} onClick={() => confirmFieldRemoval(field)}>删除</Button>}
          </dd>
        </div>)}</dl>
        : <p className="asset-editor-message">{custom
          ? "可以为这个对象补充属性，不影响模板和其他对象。"
          : owner?.typeId ? "这个模板还没有字段。" : "这份旧对象未使用模板，已有的专属属性会继续保留。"}</p>}
    </section>;
  }

  const displayType = snapshot.types.find(type => type.id === (draft?.typeId ?? selected?.typeId));
  const displayTypeName = displayType?.name ?? "未分类";
  const isObjectList = !draft && !selected;
  const listActionsDisabled = disabled || fieldDraft !== null || deleting || resource.editing.size > 0 || !canInteract();
  const viewSwitchDisabled = !active || !canInteract() || pending || snapshot.saving || resource.editing.size > 0;
  const listMenuItems: readonly MenuEntry<string | null>[] = selectedType ? [
    {id: "create-object", label: "新建对象", icon: <Icon name="plus"/>, disabled: listActionsDisabled,
      restoreFocus: false, onSelect: menuTypeId => createObjectFromMenu(menuTypeId)},
    {id: "edit-template", label: "模板设置", disabled: listActionsDisabled,
      restoreFocus: false, onSelect: menuTypeId => openSelectedTemplateSettings(menuTypeId)},
  ] : [
    {id: "create-template", label: "新建资产模板", icon: <Icon name="plus"/>, disabled: listActionsDisabled,
      restoreFocus: false, onSelect: menuTypeId => createTemplateFromMenu(menuTypeId)},
  ];
  const detailMenuItems: readonly MenuEntry<string | null>[] = [
    {id: "return-to-list", label: "返回对象列表", disabled: assetId => !assetFromMenu(assetId),
      restoreFocus: false, onSelect: returnToList},
    {id: "edit-object", label: "编辑对象", disabled: assetId => !assetFromMenu(assetId),
      restoreFocus: false, onSelect: editAsset},
    {id: "delete-object", label: "删除对象", disabled: assetId => !assetFromMenu(assetId),
      restoreFocus: false, onSelect: removeAssetFromMenu},
  ];

  const content = <div className="asset-type-editor asset-record-editor" ref={editor} tabIndex={!draft && active ? 0 : -1}>
    <header className={isObjectList ? "asset-editor-header asset-records-header" : "asset-editor-header"}>
      <div className={isObjectList ? "asset-records-heading" : undefined}>
        <h1>{draft ? draft.kind === "create" ? "新建对象" : "编辑对象" : selected ? selected.name : selectedType?.name ?? (scopeAssets.length > 0 ? "未分类对象" : "对象管理")}</h1>
        {!draft && <p>{selected
          ? `${displayTypeName}${selected.description ? ` · ${selected.description}` : ""}`
          : selectedType ? `${scopeAssets.length} 个对象 · ${scopeFields.length} 个字段`
            : scopeAssets.length > 0 ? "保留的旧对象可继续查看和编辑；新对象需要从模板创建。" : "先定义资产模板，再基于模板创建具体对象。"}</p>}
      </div>
      {isObjectList && <div className="asset-view-switch" role="group" aria-label="查看模式">
        <IconButton label="列表视图" aria-pressed={viewMode === "list"} disabled={viewSwitchDisabled}
          onClick={() => switchViewMode("list")}><Icon name="list"/></IconButton>
        <IconButton label="卡片视图" aria-pressed={viewMode === "cards"} disabled={viewSwitchDisabled}
          onClick={() => switchViewMode("cards")}><Icon name="grid"/></IconButton>
      </div>}
    </header>
    {(error || snapshot.error) && !fieldDraft && !deleting && <div className="asset-feedback" role="alert">
      <span>{error ?? snapshot.error}</span>{!draft && <Button disabled={!active || busy} onClick={() => void run(store.retry)}>重试</Button>}
    </div>}
    {snapshot.loading && <p className="asset-editor-message" role="status">正在读取对象资料…</p>}
    {snapshot.loaded && !snapshot.blocked && (draft ? <form className="asset-record-form" onSubmit={submit} noValidate aria-busy={busy || undefined}>
      <div className="asset-record-basics">
        <label className="asset-form-field"><span>对象名称</span><TextField ref={nameInput} value={draft.name} disabled={disabled} required
          autoComplete="off" aria-label="对象名称" placeholder="例如：林舟、御风诀、青铜古剑"
          onChange={event => {setDraft({...draft, name: event.currentTarget.value}); setError(null);}}/>
          <span className="asset-form-help">{[...draft.name.trim()].length}/60</span></label>
        <p className="asset-editor-message">资产模板：{displayTypeName}</p>
        <label className="asset-form-field"><span>对象简介 <span className="asset-optional">选填</span></span>
          <Textarea value={draft.description} disabled={disabled} aria-label="对象简介"
            onChange={event => {setDraft({...draft, description: event.currentTarget.value}); setError(null);}}/>
          <span className="asset-form-help">{[...draft.description].length}/200</span></label>
      </div>
      {fieldSection("模板字段", detailTemplateFields)}
      {customFields.length > 0 && fieldSection("专属属性", customFields, true)}
      {draft.kind === "create" && <p className="asset-form-help">创建对象后，可以继续添加只属于这个对象的专属属性。</p>}
      <div className="asset-record-form-actions">
        <span className="asset-form-help" role="status">{busy ? "正在保存…" : snapshot.dirty ? "保存失败，输入已保留，请重试。" : "填写完成后保存。"}</span>
        <Button type="button" disabled={busy} onClick={cancel}>{snapshot.dirty ? "关闭编辑" : "取消"}</Button>
        <Button variant="primary" type="submit" disabled={!active || busy}>{snapshot.dirty ? "重试保存" : draft.kind === "create" ? "创建对象" : "保存对象"}</Button>
      </div>
    </form> : selected ? <>
      {fieldSection("模板字段", detailTemplateFields)}
      {fieldSection("专属属性", customFields, true)}
      <p className="asset-form-help" role="status">{snapshot.saving ? "正在保存…" : snapshot.dirty ? "尚未保存" : "已保存"}</p>
    </> : <>
      {scopeAssets.length > 0 || selectedType ? viewMode === "cards"
        ? scopeAssets.length > 0 ? <ul className="asset-object-cards" aria-label={`${selectedType?.name ?? "未分类"}对象卡片`}>
          {scopeAssets.map(asset => <li className="asset-object-card" key={asset.id}>
            <header><h2><Button variant="ghost" disabled={disabled} title={asset.name}
              onClick={() => showAsset(asset.id)}><strong className="asset-object-name-label">{asset.name}</strong></Button></h2>
              {asset.description.trim() !== "" && <p className="asset-object-card-summary" title={asset.description}>{asset.description}</p>}
            </header>
            <dl className="asset-object-card-fields">
              {scopeFields.map(field => {
                const value = displayedValue(field, asset, snapshot.assets);
                const rawValue = asset.values[field.id];
                const isEmpty = rawValue === null || rawValue === undefined || rawValue === "" ||
                  (Array.isArray(rawValue) && rawValue.length === 0);
                return <div key={field.id}>
                  <dt>{field.title}</dt>
                  <dd data-value-type={field.valueType} data-empty={isEmpty || undefined} title={value}>{value}</dd>
                </div>;
              })}
            </dl>
            <footer className="asset-object-card-actions">
              <Button variant="ghost" disabled={!active || busy || snapshot.dirty || resource.editing.size > 0}
                aria-label={`查看对象“${asset.name}”`} onClick={() => showAsset(asset.id)}>查看<Icon name="chevronRight" size="small"/></Button>
              <IconButton label={`删除对象“${asset.name}”`} disabled={disabled || resource.editing.size > 0}
                onClick={() => confirmAssetRemoval(asset)}><Icon name="trash"/></IconButton>
            </footer>
          </li>)}
        </ul> : <div className="asset-object-empty">
          <p>还没有“{selectedType?.name}”对象。</p>
          <span>在此处点击右键新建对象，字段和默认值会从模板带出。</span>
        </div>
        : <div className="asset-object-table-scroll asset-object-table-frame" data-ui-density="compact" tabIndex={0} role="region" aria-label="对象数据表，可横向滚动">
        <table className="asset-object-table" aria-label={`${selectedType?.name ?? "未分类"}对象列表`}>
          <thead><tr>
            <th scope="col">对象名称</th>
            {scopeFields.map(field => <th scope="col" key={field.id} data-value-type={field.valueType}>{field.title}</th>)}
            <th scope="col" aria-label="对象操作"/>
          </tr></thead>
          <tbody>{scopeAssets.map(asset => <tr key={asset.id}>
            <th scope="row"><div className="asset-object-name"><Button variant="ghost" disabled={disabled}
              title={asset.name} aria-label={`查看对象“${asset.name}”`} onClick={() => showAsset(asset.id)}>
              <strong className="asset-object-name-label">{asset.name}</strong>
              {asset.description.trim() !== "" && <span className="asset-object-name-summary" title={asset.description}>{asset.description}</span>}
            </Button></div></th>
            {scopeFields.map(field => {
              const value = displayedValue(field, asset, snapshot.assets);
              return <td className="asset-object-value" key={field.id} data-value-type={field.valueType}>
                <span className="asset-object-cell-value" title={value}>{value}</span>
              </td>;
            })}
            <td className="asset-object-actions">
              <IconButton label={`删除对象“${asset.name}”`} disabled={disabled || resource.editing.size > 0}
                onClick={() => confirmAssetRemoval(asset)}><Icon name="trash"/></IconButton>
            </td>
          </tr>)}{scopeAssets.length === 0 && <tr><td colSpan={scopeFields.length + 2}>
          <div className="asset-object-empty"><p>还没有“{selectedType?.name}”对象。</p><span>在此处点击右键新建对象，字段和默认值会从模板带出。</span></div>
          </td></tr>}</tbody>
        </table>
      </div> : <div className="asset-editor-empty">
        <p>{types.length === 0 ? "还没有资产模板。" : "这个范围里还没有未分类对象。"}</p>
        <span>{types.length === 0
          ? "在此处点击右键新建资产模板，定义字段后再创建对象。"
          : "请先在导航中选择资产模板，再在此处点击右键新建对象。"}</span>
      </div>}
    </>)}
    <Dialog open={fieldDraft !== null && active} onOpenChange={open => {if (!open) cancel();}}
      title={fieldDraft?.kind === "renameField" ? "修改专属属性标题" : "添加专属属性"}
      description={`只属于“${selected?.name ?? "当前对象"}”，不会改变资产模板。`}
      size="regular" initialFocus={fieldInput} finalFocus={editor} busy={busy}>
      {fieldDraft && <AssetSchemaForm draft={fieldDraft} types={types} busy={busy} error={error ?? snapshot.error} inputRef={fieldInput}
        onChange={next => {setFieldDraft(next); setError(null);}} onCancel={cancel} store={store}
        onSubmit={operation => void run(snapshot.dirty ? store.retry : operation, true)}/>}
    </Dialog>
    <Dialog open={deleting && active} onOpenChange={open => {if (!open) cancel();}}
      title={deleteTarget?.kind === "field" ? "删除专属属性" : "删除对象"} size="narrow" busy={busy}
      initialFocus={deleteCancel} finalFocus={editor}
      description={deleteTarget?.kind === "field"
        ? `确定删除“${deleteTarget.assetName}”的专属属性“${deleteTarget.title}”及其填写的值吗？此操作无法撤销，资产模板和其他对象保持不变。`
        : deleteTarget ? `确定删除对象“${deleteTarget.name}”吗？它的属性值和专属属性也会删除，此操作无法撤销。` : undefined}>
      {(error || snapshot.error) && <p className="asset-form-error asset-delete-feedback" role="alert">{error ?? snapshot.error}</p>}
      {deletionPendingSave && <p className="asset-form-help asset-delete-feedback" role="status">删除变更尚未保存，请重试保存。</p>}
      <DialogActions>
        <Button ref={deleteCancel} disabled={busy} onClick={cancel}>{deletionPendingSave ? "关闭" : "取消"}</Button>
        <Button variant="danger" disabled={!active || busy} onClick={removeConfirmed}>
          {busy ? "正在删除…" : deletionPendingSave ? "重试保存" : "确认删除"}
        </Button>
      </DialogActions>
    </Dialog>
  </div>;
  const MenuRegion = contextMenus.Region;
  return <MenuRegion label={isObjectList ? "对象列表操作" : "对象详情操作"}
    context={isObjectList ? selectedType?.id ?? null : selected?.id ?? null}
    items={isObjectList ? listMenuItems : detailMenuItems} disabled={draft !== null || listActionsDisabled}
    fallbackFocus={() => editor.current}>{content}</MenuRegion>;
}

export function AssetRecordsEditor(props: AssetViewProps) {
  const project = useAssetProject(props);
  return project.resource && project.session
    ? <RecordsEditor key={project.session.id} resource={project.resource} active={project.active} canInteract={project.canInteract} onOpenTypes={props.onOpenTypes} contextMenus={props.contextMenus}/>
    : <div className="asset-type-editor"><p className="asset-editor-message">请先打开一个项目。</p></div>;
}
