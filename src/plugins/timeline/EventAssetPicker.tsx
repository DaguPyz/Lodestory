import type {Translate} from "@lodestory/sdk/i18n";
import {useId, useLayoutEffect, useRef, useState, useSyncExternalStore} from "react";
import type {AssetCatalog, AssetCatalogSnapshot} from "@lodestory/sdk/asset-catalog";
import {Button, Icon, IconButton, SearchField, Select} from "@lodestory/ui";

const EMPTY: AssetCatalogSnapshot = Object.freeze({
  types: [], assets: [], loaded: false, loading: false, error: null, blocked: false,
});
const emptySnapshot = () => EMPTY;
const emptySubscribe = () => () => {};
const PREVIEW_LIMIT = 3;

/** Selection belongs to the event draft; this view only reads the public asset catalog. */
export function EventAssetPicker({t, catalog, selectedIds, disabled, onChange}: {
  t: Translate;
  catalog: AssetCatalog | null;
  selectedIds: readonly string[];
  disabled: boolean;
  onChange(ids: readonly string[]): void;
}) {
  const snapshot = useSyncExternalStore(catalog?.subscribe ?? emptySubscribe,
    catalog?.getSnapshot ?? emptySnapshot, catalog?.getSnapshot ?? emptySnapshot);
  const headingId = useId();
  const browseId = useId();
  const selectionId = useId();
  const browsePanel = useRef<HTMLDivElement>(null);
  const [browsing, setBrowsing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [retryFailure, setRetryFailure] = useState<{
    catalog: AssetCatalog; snapshot: AssetCatalogSnapshot; message: string;
  } | null>(null);
  const retryError = retryFailure?.catalog === catalog && retryFailure.snapshot === snapshot ? retryFailure.message : null;
  const activeTypes = snapshot.types.filter(type => type.status === "active");
  const typeById = new Map(snapshot.types.map(type => [type.id, type]));
  const assetById = new Map(snapshot.assets.map(asset => [asset.id, asset]));
  const ready = snapshot.loaded && !snapshot.loading && !snapshot.blocked;
  const selectionDisabled = disabled || !ready;
  const remaining = Math.max(0, selectedIds.length - PREVIEW_LIMIT);
  const previewIds = selectedIds.slice(0, PREVIEW_LIMIT);
  const extraIds = showAll ? selectedIds.slice(PREVIEW_LIMIT) : [];
  const options = [{value: "all", label: t("全部分类")}, ...activeTypes.map(type => ({value: type.id, label: type.name})),
    {value: "uncategorized", label: t("未分类")}];
  const effectiveCategory = options.some(option => option.value === category) ? category : "all";
  const term = query.trim().normalize("NFKC").toLocaleLowerCase();
  const matches = browsing && ready ? snapshot.assets.filter(asset => {
    const type = asset.typeId ? typeById.get(asset.typeId) : undefined;
    const inCategory = effectiveCategory === "all" || (effectiveCategory === "uncategorized"
      ? !type || type.status !== "active" : asset.typeId === effectiveCategory);
    return inCategory && (!term || `${asset.name}\n${asset.description}`.normalize("NFKC").toLocaleLowerCase().includes(term));
  }) : [];

  useLayoutEffect(() => {
    if (!browsing) return;
    const panel = browsePanel.current;
    const search = panel?.querySelector<HTMLInputElement>('input[type="search"]:not(:disabled)');
    (search ?? panel)?.focus();
  }, [browsing]);

  function categoryLabel(typeId: string | null): string {
    const type = typeId ? typeById.get(typeId) : undefined;
    return type ? `${type.name}${type.status === "archived" ? t("（已归档）") : ""}` : t("未分类");
  }

  function toggle(id: string, checked: boolean) {
    if (selectionDisabled) return;
    onChange(checked ? [...selectedIds.filter(value => value !== id), id] : selectedIds.filter(value => value !== id));
  }

  async function retry() {
    if (!catalog || retrying || disabled) return;
    setRetrying(true);
    setRetryFailure(null);
    try {
      if (!await catalog.retry()) setRetryFailure({catalog, snapshot: catalog.getSnapshot(),
        message: catalog.getSnapshot().error ?? t("资产读取失败，请重试。")});
    } catch (cause) {
      setRetryFailure({catalog, snapshot: catalog.getSnapshot(),
        message: cause instanceof Error ? cause.message : t("资产读取失败，请重试。")});
    } finally { setRetrying(false); }
  }

  function selectedAsset(id: string) {
    const asset = assetById.get(id);
    const name = asset?.name ?? `${ready ? t("资产不可用") : t("资产待确认")}（${id.slice(0, 8)}）`;
    return <li key={id}>
      <span className="timeline-event-assets-selected-name" title={asset ? `${asset.name} · ${categoryLabel(asset.typeId)}` : id}>
        {name}
      </span>
      <IconButton label={t("移除关联：{name}", {values: {name}})} disabled={disabled}
        onClick={() => onChange(selectedIds.filter(value => value !== id))}><Icon name="close" size="small" /></IconButton>
    </li>;
  }

  return <section className="timeline-event-assets" aria-labelledby={headingId}>
    <div className="timeline-event-assets-heading">
      <h3 id={headingId}>{t("关联资产")}<span className="timeline-event-field-count" role="status">{t("{count} 项", {count: selectedIds.length, values: {count: selectedIds.length}})}</span></h3>
      <Button variant="secondary" aria-expanded={browsing} aria-controls={browseId} disabled={disabled}
        onClick={() => setBrowsing(value => !value)}>
        <Icon name={browsing ? "minus" : "plus"} size="small" />
        {browsing ? t("收起搜索") : t("添加资产")}
      </Button>
    </div>
    {previewIds.length > 0 && <div className="timeline-event-assets-preview">
      <ul className="timeline-event-assets-selected" aria-label={t("已关联资产")}>{previewIds.map(selectedAsset)}</ul>
      {remaining > 0 && <Button variant="ghost" aria-expanded={showAll} aria-controls={selectionId}
        aria-label={showAll ? t("收起其余关联资产") : t("查看其余 {remaining} 项关联资产", {values: {remaining}})}
        onClick={() => setShowAll(value => !value)}>
        {showAll ? t("收起") : `+${remaining}`}<Icon name="chevronDown" size="small" />
      </Button>}
    </div>}
    <ul id={selectionId} className="timeline-event-assets-selected timeline-event-assets-extra" aria-label={t("其余关联资产")}
      hidden={extraIds.length === 0}>{extraIds.map(selectedAsset)}</ul>
    <div id={browseId} className="timeline-event-assets-browser" ref={browsePanel} tabIndex={-1} hidden={!browsing}>
      {browsing && <>
        <div className="timeline-event-assets-filters">
          <Select aria-label={t("资产分类")} value={effectiveCategory} options={options} onValueChange={setCategory} disabled={disabled || !ready}/>
          <SearchField label={t("搜索资产")} placeholder={t("搜索资产名称或说明")} value={query}
            onChange={event => setQuery(event.target.value)} disabled={disabled || !ready}
            onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} />
        </div>
        {(snapshot.error || retryError) && <div className="timeline-event-assets-error" role="alert">
          <span>{snapshot.error ?? retryError}</span>
          <Button type="button" variant="ghost" disabled={disabled || retrying || snapshot.loading} onClick={() => void retry()}>
            {retrying ? t("正在重试…") : t("重试读取资产")}
          </Button>
        </div>}
        {!catalog ? <p className="timeline-event-assets-feedback" role="status">{t("当前无法读取资产，已有的关联会保留。")}</p>
          : snapshot.loading ? <p className="timeline-event-assets-feedback" role="status">{t("正在读取资产…")}</p>
          : !ready ? <p className="timeline-event-assets-feedback" role="status">{t("资产暂不可用，已有的关联会保留。")}</p>
          : matches.length === 0 ? <p className="timeline-event-assets-feedback" role="status">
            {snapshot.assets.length === 0 ? t("暂无资产，请先在资产管理中创建。") : t("没有匹配的资产。")}
          </p> : <ul className="timeline-event-assets-results" aria-label={t("可关联资产")}>
            {matches.map(asset => <li key={asset.id}>
              <label className="timeline-event-asset-option">
                <span className="timeline-event-checkbox">
                  <input type="checkbox" aria-label={asset.name} checked={selectedIds.includes(asset.id)}
                    disabled={selectionDisabled} onChange={event => toggle(asset.id, event.target.checked)}/>
                  <Icon name="check" size="small" />
                </span>
                <span className="timeline-event-asset-detail">
                  <span className="timeline-event-asset-name">{asset.name}</span>
                  {asset.description && <span className="timeline-event-asset-description">{asset.description}</span>}
                </span>
                <span className="timeline-event-asset-category">{categoryLabel(asset.typeId)}</span>
              </label>
            </li>)}
          </ul>}
      </>}
    </div>
  </section>;
}
