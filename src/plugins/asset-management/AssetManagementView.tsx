import type {I18nService, Translate} from "@lodestory/sdk/i18n";
import {useTranslation} from "../../utils/useTranslation";
import {useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import type {WorkbenchService} from "@lodestory/sdk/workbench";
import type {ContextMenuService, MenuEntry} from "@lodestory/sdk/context-menu";
import {Button, Dialog, DialogActions, Icon, IconButton} from "@lodestory/ui";
import type {AssetSessionResources} from "./assetManagementPlugin";
import type {AssetFieldDefinition} from "./assetSchemaStore";
import {AssetSchemaForm, type AssetSchemaDraft} from "./AssetSchemaForm";
import {assetCardColorStyle} from "./assetCardColor";

export type AssetViewProps = {
  i18n?: I18nService;
  workbench: WorkbenchService;
  contextMenus: ContextMenuService;
  sessions: ReadonlyMap<string, AssetSessionResources>;
  active: boolean;
  onOpenTypes: () => void;
};
type SessionProps = {t: Translate; resource: AssetSessionResources; contextMenus: ContextMenuService; active: boolean; onOpenTypes: () => void; onOpenAssets: () => void; canInteract: () => boolean};
const valueLabels = {text: "文字", number: "数字", singleSelect: "单选", multiSelect: "多选", reference: "关联对象"};

export function useAssetProject({workbench, sessions, active}: AssetViewProps) {
  const snapshot = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot, workbench.getSnapshot);
  return {session: snapshot.session, resource: snapshot.session ? sessions.get(snapshot.session.id) : undefined,
    active: active && snapshot.active && !snapshot.busy,
    canInteract: () => {
      const current = workbench.getSnapshot();
      return active && current.active && !current.busy && current.session?.id === snapshot.session?.id;
    }};
}

function OrderButtons({t, label, first, last, disabled, onMove}: {
  t: Translate; label: string; first: boolean; last: boolean; disabled: boolean; onMove(direction: -1 | 1): void;
}) {
  return <span className="asset-order-buttons">
    <span className="asset-order-up"><IconButton label={t("上移{label}", {values: {label}})} disabled={disabled || first} onClick={() => onMove(-1)}><Icon name="chevronDown" size="small"/></IconButton></span>
    <IconButton label={t("下移{label}", {values: {label}})} disabled={disabled || last} onClick={() => onMove(1)}><Icon name="chevronDown" size="small"/></IconButton>
  </span>;
}

function TypeNavigation({t, resource, contextMenus, active, onOpenTypes, onOpenAssets, canInteract}: SessionProps) {
  const {store} = resource;
  const MenuRegion = contextMenus.Region;
  const listSurface = useRef<HTMLDivElement>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const editingToken = useRef(Symbol("asset-navigation-delete"));
  const epoch = useRef(0);
  const [deleteTarget, setDeleteTarget] = useState<{id: string; name: string} | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const types = snapshot.types.filter(item => item.status === "active").sort((a, b) => a.order - b.order);
  const disabled = !active || snapshot.loading || snapshot.saving || snapshot.blocked || !snapshot.loaded || snapshot.dirty || pending || deleteTarget !== null;
  const deletionPendingSave = deleteTarget !== null && snapshot.dirty
    && (snapshot.pendingTypeRemoval === deleteTarget.id || !snapshot.types.some(type => type.id === deleteTarget.id));
  useLayoutEffect(() => () => {
    epoch.current++;
    resource.editing.delete(editingToken.current);
  }, [resource]);
  const counts = useMemo(() => {
    const byType = new Map<string | null, number>();
    for (const asset of snapshot.assets) byType.set(asset.typeId, (byType.get(asset.typeId) ?? 0) + 1);
    return byType;
  }, [snapshot.assets]);
  const unclassifiedCount = snapshot.assets.length - types.reduce((total, type) => total + (counts.get(type.id) ?? 0), 0);
  function openTemplate(id: string | null) {
    if (!canInteract() || resource.editing.size > 0) return;
    if (store.selectType(id) && store.selectAsset(null)) onOpenAssets();
  }
  function canManage() {
    const current = store.getSnapshot();
    return canInteract() && resource.editing.size === 0 && current.loaded && !current.loading && !current.saving && !current.blocked && !current.dirty;
  }
  function newTemplate() {
    if (canManage() && store.requestTypeCreation()) onOpenTypes();
  }
  function openSettings(id: string) {
    if (!canManage() || !store.getSnapshot().types.some(type => type.id === id && type.status === "active")) return;
    if (store.selectType(id) && store.selectAsset(null)) onOpenTypes();
  }
  function confirmRemoval(id: string) {
    if (!canManage()) return;
    const target = store.getSnapshot().types.find(type => type.id === id && type.status === "active");
    if (!target) return;
    resource.editing.add(editingToken.current);
    setError(null);
    setDeleteTarget({id: target.id, name: target.name});
  }
  function closeRemoval() {
    if (pending || snapshot.saving) return;
    resource.editing.delete(editingToken.current);
    setDeleteTarget(null);
    setError(null);
  }
  async function removeConfirmed() {
    if (!deleteTarget || !active || !canInteract() || pending || snapshot.saving) return;
    const operationEpoch = epoch.current;
    setPending(true);
    setError(null);
    try {
      const accepted = await (deletionPendingSave ? store.retry() : store.removeType(deleteTarget.id));
      if (operationEpoch !== epoch.current) return;
      if (accepted) {
        resource.editing.delete(editingToken.current);
        setDeleteTarget(null);
      } else setError(store.getSnapshot().error ?? t("未能保存，请重试。"));
    } catch (cause) {
      if (operationEpoch === epoch.current) setError(cause instanceof Error ? cause.message : t("保存失败，请重试。"));
    } finally {
      if (operationEpoch === epoch.current) setPending(false);
    }
  }
  return <MenuRegion label={t("资产模板列表操作")} disabled={disabled} fallbackFocus={() => listSurface.current}
    items={[{id: "new-template", label: t("新建资产模板"), icon: <Icon name="plus"/>, disabled: () => !canManage(), restoreFocus: false, onSelect: newTemplate}]}>
  <div className="asset-navigation" ref={listSurface} tabIndex={active ? 0 : -1} aria-label={t("资产模板列表")}>
    {snapshot.loading && <p className="asset-navigation-message" role="status">{t("正在读取资产模板…")}</p>}
    {snapshot.error && <p className="asset-navigation-message" role="alert">{t(snapshot.error)}</p>}
    {snapshot.loaded && !snapshot.blocked && types.length === 0 && <p className="asset-navigation-message">{t("右键新建资产模板，定义字段后再添加具体对象。")}</p>}
    <ul className="asset-type-list" aria-label={t("资产模板")}>
      {types.map(type => {
        const objectCount = counts.get(type.id) ?? 0;
        return <li key={type.id}>
          <MenuRegion context={type.id} label={t("{name}资产模板操作", {values: {name: type.name}})} disabled={disabled} fallbackFocus={() => listSurface.current} items={[
            {id: "template-settings", label: t("模板设置"), disabled: () => !canManage(), restoreFocus: false, onSelect: openSettings},
            {id: "delete-template", label: t("删除模板"), disabled: () => !canManage(), restoreFocus: false, onSelect: confirmRemoval},
            {id: "new-template", label: t("新建资产模板"), icon: <Icon name="plus"/>, disabled: () => !canManage(), restoreFocus: false, onSelect: newTemplate},
          ]}>
          <button type="button" className="asset-type-entry" aria-label={t("{name}，{count} 个对象", {count: objectCount, values: {name: type.name, count: objectCount}})}
            data-colored={type.color ? true : undefined} style={assetCardColorStyle(type.color)}
            aria-pressed={snapshot.selectedTypeId === type.id} disabled={!active} onClick={() => openTemplate(type.id)}>
            <strong className="asset-type-name" title={type.name}>{type.name}</strong>
            <span className="asset-type-count" aria-hidden="true">{objectCount}</span>
          </button>
          </MenuRegion>
        </li>;
      })}
      {unclassifiedCount > 0 && <li><button type="button" className="asset-type-entry" disabled={!active}
        aria-label={t("未分类对象，{unclassifiedCount} 个旧对象", {values: {unclassifiedCount}})}
        aria-pressed={snapshot.selectedTypeId === null} onClick={() => openTemplate(null)}>
        <strong className="asset-type-name" title={t("未分类对象")}>{t("未分类对象")}</strong>
        <span className="asset-type-count" aria-hidden="true">{unclassifiedCount}</span>
      </button></li>}
    </ul>
    <Dialog open={deleteTarget !== null && active} onOpenChange={open => {if (!open) closeRemoval();}}
      title={t("删除资产模板")} size="narrow" busy={pending || snapshot.saving} initialFocus={deleteCancel} finalFocus={listSurface}
      description={deleteTarget ? t("确定删除资产模板“{name}”及其全部字段定义吗？此操作无法撤销。仍被对象或其他关联字段使用的模板无法删除。", {values: {name: deleteTarget.name}}) : undefined}>
      {(error ?? (deletionPendingSave ? snapshot.error : null)) && <p className="asset-form-error asset-delete-feedback" role="alert">{t(error ?? snapshot.error ?? "")}</p>}
      {deletionPendingSave && <p className="asset-form-help asset-delete-feedback" role="status">{t("删除变更尚未保存，请重试保存。")}</p>}
      <DialogActions>
        <Button variant="secondary" ref={deleteCancel} disabled={pending || snapshot.saving} onClick={closeRemoval}>{deletionPendingSave ? t("关闭") : t("取消")}</Button>
        <Button variant="danger" disabled={!active || pending || snapshot.saving} onClick={() => void removeConfirmed()}>
          {pending || snapshot.saving ? t("正在删除…") : deletionPendingSave ? t("重试保存") : t("确认删除")}
        </Button>
      </DialogActions>
    </Dialog>
  </div>
  </MenuRegion>;
}

export function AssetTypeNavigation(props: AssetViewProps & {onOpenAssets: () => void}) {
  const project = useAssetProject(props);
  const t = useTranslation(props.i18n);
  return project.resource && project.session
    ? <TypeNavigation t={t} key={project.session.id} resource={project.resource} contextMenus={props.contextMenus} active={project.active} onOpenTypes={props.onOpenTypes} onOpenAssets={props.onOpenAssets} canInteract={project.canInteract}/>
    : <p className="asset-navigation-message">{t("请先打开一个项目。")}</p>;
}

function configurationLabel(t: Translate, field: AssetFieldDefinition, types: readonly {id: string; name: string}[]) {
  if (field.valueType === "singleSelect" || field.valueType === "multiSelect") {
    const options = field.config.options ?? [];
    const defaults = Array.isArray(field.defaultValue) ? field.defaultValue : typeof field.defaultValue === "string" ? [field.defaultValue] : [];
    const names = options.filter(option => defaults.includes(option.id)).map(option => option.title);
    return options.map(item => item.title).join("、") + (names.length ? t(" · 默认：{value}", {values: {value: names.join("、")}}) : "");
  }
  if (field.valueType === "reference") return field.config.targetTypeId
    ? types.find(item => item.id === field.config.targetTypeId)?.name ?? t("指定类型") : t("所有资产类型");
  if (field.defaultValue !== undefined && field.defaultValue !== null) return t("默认：{defaultValue}", {values: {defaultValue: String(field.defaultValue)}});
  return "—";
}

function TypeEditor({t, resource, contextMenus, active, canInteract, onOpenAssets}: SessionProps) {
  const {store} = resource;
  const MenuRegion = contextMenus.Region;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const types = snapshot.types.filter(item => item.status === "active").sort((a, b) => a.order - b.order);
  const selected = types.find(type => type.id === snapshot.selectedTypeId);
  const fields = snapshot.fields.filter(field => field.owner.kind === "type" && field.owner.id === selected?.id && field.status === "active").sort((a, b) => a.order - b.order);
  const [draft, setDraft] = useState<AssetSchemaDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{id: string; name: string} | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const editingToken = useRef(Symbol("asset-schema-editor"));
  const handledCreationRequest = useRef(resource.handledTypeCreationRequest ?? 0);
  const epoch = useRef(0);
  const reorderRequests = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const disabled = !active || !snapshot.loaded || snapshot.loading || snapshot.blocked || snapshot.saving || snapshot.dirty || pending;
  const editing = draft !== null || deleteTarget !== null;
  const deletionPendingSave = deleteTarget !== null && snapshot.dirty
    && (snapshot.pendingTypeRemoval === deleteTarget.id || !snapshot.types.some(type => type.id === deleteTarget.id));
  const deletionError = error ?? (deletionPendingSave ? snapshot.error : null);
  const orderDisabled = !active || !snapshot.loaded || snapshot.loading || snapshot.blocked || snapshot.orderBlocked || editing
    || pending && !snapshot.reordering || snapshot.dirty && !snapshot.reordering || snapshot.saving && !snapshot.reordering;

  useLayoutEffect(() => () => {
    epoch.current++;
    resource.editing.delete(editingToken.current);
  }, [resource]);
  useLayoutEffect(() => {
    if (snapshot.typeCreationRequest <= handledCreationRequest.current || disabled || editing || !canInteract() || resource.editing.size > 0) return;
    handledCreationRequest.current = snapshot.typeCreationRequest;
    resource.handledTypeCreationRequest = snapshot.typeCreationRequest;
    newType();
  }, [snapshot.typeCreationRequest, disabled, editing, active]);

  function begin(next: AssetSchemaDraft) {
    if (disabled || !canInteract() || resource.editing.size > 0) return;
    resource.editing.add(editingToken.current);
    setDraft(next);
    setError(null);
  }
  function close() {
    if (pending || snapshot.saving) return;
    resource.editing.delete(editingToken.current);
    setDraft(null);
    setDeleteTarget(null);
    setError(null);
  }
  async function run(operation: () => Promise<boolean>, closeOnSuccess = false) {
    if (!activeRef.current || !canInteract() || pending) return;
    if (resource.editing.size > 0 && !resource.editing.has(editingToken.current)) return;
    const operationEpoch = epoch.current;
    setPending(true);
    setError(null);
    try {
      const accepted = await operation();
      if (operationEpoch !== epoch.current) return;
      if (accepted && closeOnSuccess) {
        resource.editing.delete(editingToken.current);
        setDraft(null);
        setDeleteTarget(null);
      } else if (!accepted) setError(store.getSnapshot().error ?? t("未能保存，请检查内容后重试。"));
    } catch (cause) {
      if (operationEpoch === epoch.current) setError(cause instanceof Error ? cause.message : t("保存失败，请重试。"));
    } finally {
      if (operationEpoch === epoch.current) setPending(false);
    }
  }
  async function moveType(id: string, direction: -1 | 1) {
    const current = store.getSnapshot();
    if (!activeRef.current || !canInteract() || resource.editing.size > 0 || !current.loaded || current.loading || current.blocked
      || current.orderBlocked || (pending && !current.reordering) || (current.saving && !current.reordering) || (current.dirty && !current.reordering)) return;
    const operationEpoch = epoch.current;
    reorderRequests.current++;
    setPending(true);
    setError(null);
    try {
      const accepted = await store.moveType(id, direction);
      if (operationEpoch !== epoch.current) return;
      if (!accepted) setError(store.getSnapshot().error ?? t("未能保存模板顺序，请重试。"));
    } catch (cause) {
      if (operationEpoch === epoch.current) setError(cause instanceof Error ? cause.message : t("保存失败，请重试。"));
    } finally {
      if (operationEpoch === epoch.current) {
        reorderRequests.current = Math.max(0, reorderRequests.current - 1);
        setPending(reorderRequests.current > 0);
      }
    }
  }
  function newType() {
    const current = store.getSnapshot();
    if (!current.loaded || current.loading || current.blocked || current.saving || current.dirty) return;
    begin({kind: "newType", id: crypto.randomUUID(), name: "", description: "", color: null});
  }
  function canNavigate(typeId: string | null) {
    const current = store.getSnapshot();
    return activeRef.current && canInteract() && !pending && !current.saving && !editing &&
      resource.editing.size === 0 && current.selectedTypeId === typeId;
  }
  function canManageFromMenu(typeId: string | null) {
    const current = store.getSnapshot();
    return canNavigate(typeId) && current.loaded && !current.loading && !current.blocked && !current.dirty;
  }
  function templateFromMenu(typeId: string | null) {
    if (!canManageFromMenu(typeId)) return undefined;
    return store.getSnapshot().types.find(type => type.id === typeId && type.status === "active");
  }
  function returnToAssets(typeId: string | null) {
    if (canNavigate(typeId) && store.selectAsset(null)) onOpenAssets();
  }
  function editTemplate(typeId: string | null) {
    const target = templateFromMenu(typeId);
    if (target) begin({kind: "editType", id: target.id, name: target.name, description: target.description, color: target.color ?? null});
  }
  function newField(typeId: string | null) {
    const target = templateFromMenu(typeId);
    if (!target) return;
    begin({kind: "newField", id: crypto.randomUUID(), typeId: target.id, title: "", valueType: "text",
      options: [], targetTypeId: null, defaultText: "", defaultOptions: []});
  }
  function renameField(field: AssetFieldDefinition) {
    begin({kind: "renameField", id: field.id, typeId: field.owner.id, title: field.title, valueType: field.valueType,
      options: [], targetTypeId: null, defaultText: "", defaultOptions: []});
  }
  function confirmRemoval(typeId: string | null) {
    const target = templateFromMenu(typeId);
    if (!target || disabled) return;
    resource.editing.add(editingToken.current);
    setError(null);
    setDeleteTarget({id: target.id, name: target.name});
  }
  function removeConfirmed() {
    if (!deleteTarget || !active || !canInteract() || pending || snapshot.saving) return;
    const target = deleteTarget;
    void run(() => deletionPendingSave ? store.retry() : store.removeType(target.id), true);
  }
  const typeDraft = draft?.kind === "newType" || draft?.kind === "editType" ? draft : null;
  const fieldDraft = draft?.kind === "newField" || draft?.kind === "renameField" ? draft : null;
  const templateActions: readonly MenuEntry<string | null>[] = selected ? [
    {id: "edit-template", label: t("编辑模板"), disabled: typeId => !templateFromMenu(typeId), restoreFocus: false, onSelect: editTemplate},
    {id: "delete-template", label: t("删除模板"), disabled: typeId => !templateFromMenu(typeId), restoreFocus: false, onSelect: confirmRemoval},
    {id: "new-field", label: t("添加字段"), icon: <Icon name="plus"/>, disabled: typeId => !templateFromMenu(typeId), restoreFocus: false, onSelect: newField},
  ] : [];
  const menuItems: readonly MenuEntry<string | null>[] = [
    {id: "return-to-assets", label: t("返回对象列表"), disabled: typeId => !canNavigate(typeId), restoreFocus: false, onSelect: returnToAssets},
    ...templateActions,
    {id: "new-template-separator", type: "separator"},
    {id: "new-template", label: t("新建资产模板"), icon: <Icon name="plus"/>, disabled: typeId => !canManageFromMenu(typeId),
      restoreFocus: false, onSelect: typeId => {if (canManageFromMenu(typeId)) newType();}},
  ];
  return <MenuRegion label={t("资产模板设置操作")} context={snapshot.selectedTypeId}
    disabled={!active || editing || pending || snapshot.saving} fallbackFocus={() => editor.current} items={menuItems}>
  <div className="asset-type-editor asset-template-settings" ref={editor} tabIndex={active ? 0 : -1}>
    <header className="asset-editor-header">
      <div className="asset-editor-heading-with-back">
        <h1>{selected ? t("{name} · 模板设置", {values: {name: selected.name}}) : t("资产模板")}</h1>
        <div className="asset-editor-back">
          <Button variant="ghost" disabled={!canNavigate(snapshot.selectedTypeId)} onClick={() => returnToAssets(snapshot.selectedTypeId)}>
            <Icon name="arrowLeft" size="small" />
            <span>{selected ? t("返回{name}列表", {values: {name: selected.name}}) : t("返回对象列表")}</span>
          </Button>
        </div>
        <p>{selected ? t("配置这个模板下所有对象共用的字段、字段类型和默认值。") : t("先定义资产模板，再基于模板创建具体对象。")}</p>
      </div>
    </header>
    {(error || snapshot.error) && !editing && <div className="asset-feedback" role="alert"><span>{t(error ?? snapshot.error ?? "")}</span>
      {(snapshot.dirty || snapshot.blocked || snapshot.orderBlocked || !snapshot.loaded) && <Button variant="ghost" disabled={!active || pending || snapshot.saving}
        onClick={() => void run(store.retry)}>{t("重试")}</Button>}</div>}
    {snapshot.loading && <p className="asset-editor-message" role="status">{t("正在读取资产模板…")}</p>}
    {snapshot.loaded && !snapshot.blocked && <>
      {selected ? <section className="asset-fields" aria-label={t("{name}的字段定义", {values: {name: selected.name}})}>
        {types.length > 1 && <div className="asset-template-order"><span>{t("模板顺序")}</span>
          <OrderButtons t={t} label={t("模板“{name}”", {values: {name: selected.name}})} first={types[0]?.id === selected.id} last={types[types.length - 1]?.id === selected.id}
            disabled={orderDisabled} onMove={direction => void moveType(selected.id, direction)}/>
        </div>}
        <div className="asset-fields-heading"><h2>{t("字段")}</h2><span role="status">{t("{count} 个字段", {count: fields.length, values: {count: fields.length}})} · {snapshot.saving ? t("正在保存…") : snapshot.dirty ? t("尚未保存") : t("已保存")}</span></div>
        {fields.length ? <div className="asset-fields-scroll"><table className="asset-fields-table">
          <thead><tr><th scope="col">{t("字段名称")}</th><th scope="col">{t("字段类型")}</th><th scope="col">{t("选项 / 默认值")}</th><th scope="col">{t("顺序")}</th></tr></thead>
          <tbody>{fields.map((field, index) => <tr key={field.id}>
            <td><Button variant="ghost" title={t("修改字段名称")} aria-label={t("修改“{title}”的字段名称", {values: {title: field.title}})} disabled={disabled || editing} onClick={() => renameField(field)}>{field.title}</Button></td>
            <td>{t(valueLabels[field.valueType])}</td>
            <td><span className="asset-field-config" title={configurationLabel(t, field, types)}>{configurationLabel(t, field, types)}</span></td>
            <td><OrderButtons t={t} label={t("字段“{title}”", {values: {title: field.title}})} first={index === 0} last={index === fields.length - 1} disabled={disabled || editing}
              onMove={direction => void run(() => store.moveField(field.id, direction))}/></td>
          </tr>)}</tbody>
        </table></div> : <div className="asset-editor-empty"><p>{t("这个模板还没有字段。")}</p><span>{t("右键选择“添加字段”，例如为人物添加“身份”，为物品添加“材质”。")}</span></div>}
      </section> : <div className="asset-editor-empty"><p>{t("右键新建一份资产模板。")}</p><span>{t("例如，人物模板包含“年龄”和“身份”；之后就可以创建具体人物。")}</span></div>}
    </>}
    <Dialog open={draft !== null && active} onOpenChange={open => { if (!open) close(); }}
      title={typeDraft ? typeDraft.kind === "newType" ? t("新建资产模板") : t("编辑资产模板") : fieldDraft?.kind === "renameField" ? t("修改字段名称") : t("添加字段")}
      description={typeDraft ? t("模板决定具体对象有哪些字段。") : fieldDraft?.kind === "renameField" ? t("修改展示名称，已有内容和关联保持不变。") : t("为“{value}”的所有对象定义一个字段。", {values: {value: selected?.name ?? t("当前模板")}})}
      size="regular" initialFocus={input} finalFocus={editor} busy={pending || snapshot.saving}>
      {draft && <AssetSchemaForm t={t} draft={draft} types={types} busy={pending || snapshot.saving} error={t(error ?? snapshot.error ?? "")}
        inputRef={input} onChange={next => { setError(null); setDraft(next); }} onCancel={close} onSubmit={operation => void run(operation, true)} store={store}/>}
    </Dialog>
    <Dialog open={deleteTarget !== null && active} onOpenChange={open => {if (!open) close();}}
      title={t("删除资产模板")} size="narrow" busy={pending || snapshot.saving} initialFocus={deleteCancel} finalFocus={editor}
      description={deleteTarget ? t("确定删除资产模板“{name}”及其全部字段定义吗？此操作无法撤销。仍被对象或其他关联字段使用的模板无法删除。", {values: {name: deleteTarget.name}}) : undefined}>
      {deletionError && <p className="asset-form-error asset-delete-feedback" role="alert">{t(deletionError)}</p>}
      {deletionPendingSave && <p className="asset-form-help asset-delete-feedback" role="status">{t("删除变更尚未保存，请重试保存。")}</p>}
      <DialogActions>
        <Button variant="secondary" ref={deleteCancel} disabled={pending || snapshot.saving} onClick={close}>{deletionPendingSave ? t("关闭") : t("取消")}</Button>
        <Button variant="danger" disabled={!active || pending || snapshot.saving} onClick={removeConfirmed}>
          {pending || snapshot.saving ? t("正在删除…") : deletionPendingSave ? t("重试保存") : t("确认删除")}
        </Button>
      </DialogActions>
    </Dialog>
  </div>
  </MenuRegion>;
}

export function AssetTypeEditor(props: AssetViewProps & {onOpenAssets: () => void}) {
  const project = useAssetProject(props);
  const t = useTranslation(props.i18n);
  return project.resource && project.session
    ? <TypeEditor t={t} key={project.session.id} resource={project.resource} contextMenus={props.contextMenus} active={project.active} onOpenTypes={props.onOpenTypes} onOpenAssets={props.onOpenAssets} canInteract={project.canInteract}/>
    : <div className="asset-type-editor"><p className="asset-editor-message">{t("请先打开一个项目。")}</p></div>;
}
