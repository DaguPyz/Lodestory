import {useEffect, useState, useSyncExternalStore} from "react";
import {Button} from "@lodestory/ui";
import type {ImportedPluginPackage, PluginPackagesService} from "@lodestory/sdk/plugin-packages";
import type {ExternalPluginStatus, ExternalPluginsService} from "@lodestory/sdk/external-plugins";
import type {SettingsService} from "@lodestory/sdk/settings";
import type {UiService} from "@lodestory/sdk/ui";
import "./plugin-settings.css";

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "无法读取插件，请重试。";
}

const statusLabels: Record<ExternalPluginStatus["state"], string> = {
  loading: "正在加载…",
  enabled: "已启用",
  disabling: "正在停用…",
  disabled: "已停用",
  uninstalling: "正在卸载…",
  error: "加载失败",
  "stop-error": "停用未完成",
  "uninstall-error": "卸载未完成",
};

export function PluginSettings({packages, plugins, settings, ui}: {packages: PluginPackagesService; plugins: ExternalPluginsService; settings: SettingsService; ui: UiService}) {
  const [items, setItems] = useState<readonly ImportedPluginPackage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [listFailure, setListFailure] = useState("");
  const [operationFailure, setOperationFailure] = useState("");
  const [refresh, setRefresh] = useState(0);
  const statuses = useSyncExternalStore(plugins.subscribe, plugins.getSnapshot, plugins.getSnapshot);

  useEffect(() => packages.subscribe(() => setRefresh(value => value + 1)), [packages]);

  useEffect(() => {
    let current = true;
    packages.list().then(value => {if (current) {setItems(value); setListFailure("");}}, error => {
      if (current) {setItems(null); setListFailure(message(error));}
    });
    return () => {current = false;};
  }, [packages, refresh]);

  async function runOperation(operation: () => Promise<unknown>, getPluginId?: () => string | undefined) {
    setBusy(true);
    setOperationFailure("");
    try {await operation();}
    catch (error) {
      const text = message(error);
      const pluginError = getPluginId ? plugins.getSnapshot()[getPluginId() ?? ""]?.error : undefined;
      if (pluginError !== text) setOperationFailure(text);
    }
    finally {
      setRefresh(value => value + 1);
      setBusy(false);
    }
  }

  async function importPackage() {
    let importedId: string | undefined;
    await runOperation(async () => {
      const imported = await packages.importFromFile();
      if (imported) {
        importedId = imported.id;
        await plugins.enable(imported.id);
      }
    }, () => importedId);
  }

  async function openPage(id: string) {
    await runOperation(async () => {
      if (await ui.openPage(id)) settings.close();
      else throw new Error("暂时无法打开插件页面，请稍后重试。");
    });
  }

  return <div className="plugin-settings">
    <p className="plugin-settings-description">导入本地插件包，成功后即可使用。卸载只移除 Lodestory 中的插件包，不会删除项目或文稿。</p>
    <Button variant="primary" disabled={busy} onClick={() => {void importPackage();}}>
      {busy ? "正在处理…" : "导入插件包"}
    </Button>
    {operationFailure && <p className="plugin-settings-error" role="alert">{operationFailure}</p>}
    <section className="plugin-settings-list" aria-label="已导入的插件">
      <h3>已导入的插件</h3>
      {items === null && !listFailure && <p className="plugin-settings-hint" role="status">正在读取…</p>}
      {listFailure && <p className="plugin-settings-error" role="alert">{listFailure}</p>}
      {items?.length === 0 && <p className="plugin-settings-hint">还没有导入插件包。</p>}
      {items && items.length > 0 && <ul>
        {items.map(item => <li className="plugin-settings-row" key={item.id}>
          <PluginRow item={item} status={statuses[item.id]} busy={busy}
            onEnable={() => {void runOperation(() => plugins.enable(item.id), () => item.id);}}
            onDisable={() => {void runOperation(() => plugins.disable(item.id), () => item.id);}}
            onUninstall={() => {void runOperation(() => plugins.uninstall(item.id), () => item.id);}}
            onOpenPage={pageId => {void openPage(pageId);}} />
        </li>)}
      </ul>}
    </section>
  </div>;
}

function PluginRow({item, status, busy, onEnable, onDisable, onUninstall, onOpenPage}: {
  item: ImportedPluginPackage;
  status: ExternalPluginStatus | undefined;
  busy: boolean;
  onEnable(): void;
  onDisable(): void;
  onUninstall(): void;
  onOpenPage(id: string): void;
}) {
  const state = status?.state;
  const changing = state === "loading" || state === "disabling" || state === "uninstalling";
  const unavailable = status?.canRetry === false;
  const removalPending = item.removalPending === true;
  const isEnabled = state === "enabled";
  const label = removalPending ? "卸载未完成" : state ? statusLabels[state]
    : item.disabled === true ? "已停用" : "已导入，待加载";
  const showEnable = !removalPending && !changing && state !== "stop-error" && !isEnabled && !unavailable;
  const showDisable = !removalPending && !changing && !unavailable
    && (isEnabled || (state === "stop-error" && status?.canRetry === true));
  const showUninstall = removalPending || (!changing && !unavailable);
  const enableLabel = state === "disabled" || item.disabled === true ? "启用" : state === "error" ? "重试加载" : "加载";

  return <>
    <div className="plugin-settings-identity">
      <strong>{item.name}</strong>
      <span>{item.id} · {item.version}</span>
      {status?.error && <span className="plugin-settings-error" role="alert">{status.error}</span>}
    </div>
    <div className="plugin-settings-actions">
      <span className="plugin-settings-status" role="status">{label}</span>
      {showEnable && <Button disabled={busy} onClick={onEnable}>{enableLabel}</Button>}
      {showDisable && <Button disabled={busy} onClick={onDisable}>{state === "stop-error" ? "重试停用" : "停用"}</Button>}
      {showUninstall && <Button variant="danger" disabled={busy} onClick={onUninstall}>
        {removalPending || state === "uninstall-error" ? "重试卸载" : "卸载"}
      </Button>}
      {status?.pages?.map(page => <Button key={page.id} disabled={busy}
        onClick={() => {onOpenPage(page.id);}}>打开{page.label}</Button>)}
    </div>
  </>;
}
