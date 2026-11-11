import {useEffect, useState, useSyncExternalStore} from "react";
import {Button} from "@lodestory/ui";
import type {ImportedPluginPackage, PluginPackagesService} from "@lodestory/sdk/plugin-packages";
import type {ExternalPluginsService} from "@lodestory/sdk/external-plugins";
import type {SettingsService} from "@lodestory/sdk/settings";
import type {UiService} from "@lodestory/sdk/ui";
import "./plugin-settings.css";

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "无法读取插件，请重试。";
}

export function PluginSettings({packages, plugins, settings, ui}: {packages: PluginPackagesService; plugins: ExternalPluginsService; settings: SettingsService; ui: UiService}) {
  const [items, setItems] = useState<readonly ImportedPluginPackage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [refresh, setRefresh] = useState(0);
  const statuses = useSyncExternalStore(plugins.subscribe, plugins.getSnapshot, plugins.getSnapshot);

  useEffect(() => packages.subscribe(() => setRefresh(value => value + 1)), [packages]);

  useEffect(() => {
    let current = true;
    packages.list().then(value => {if (current) {setItems(value); setFailure("");}}, error => {
      if (current) {setItems(null); setFailure(message(error));}
    });
    return () => {current = false;};
  }, [packages, refresh]);

  async function importPackage() {
    setBusy(true);
    setFailure("");
    try {
      const imported = await packages.importFromFile();
      if (imported) await plugins.enable(imported.id);
    } catch (error) {setFailure(message(error));}
    finally {setBusy(false);}
  }

  async function openPage(id: string) {
    setBusy(true);
    setFailure("");
    try {
      if (await ui.openPage(id)) settings.close();
      else setFailure("暂时无法打开插件页面，请稍后重试。");
    } catch (error) {setFailure(message(error));}
    finally {setBusy(false);}
  }

  return <div className="plugin-settings">
    <p className="plugin-settings-description">导入本地插件包，成功后即可使用。</p>
    <Button variant="primary" disabled={busy} onClick={() => {void importPackage();}}>
      {busy ? "正在导入…" : "导入插件包"}
    </Button>
    {failure && <p className="plugin-settings-error" role="alert">{failure}</p>}
    <section className="plugin-settings-list" aria-label="已导入的插件">
      <h3>已导入的插件</h3>
      {items === null && !failure && <p className="plugin-settings-hint" role="status">正在读取…</p>}
      {items?.length === 0 && <p className="plugin-settings-hint">还没有导入插件包。</p>}
      {items && items.length > 0 && <ul>
        {items.map(item => <li className="plugin-settings-row" key={item.id}>
          <div className="plugin-settings-identity"><strong>{item.name}</strong><span>{item.id} · {item.version}</span>
            {statuses[item.id]?.state === "error" && <span className="plugin-settings-error" role="alert">{statuses[item.id].error}</span>}
          </div>
          <div className="plugin-settings-actions">
            <span className="plugin-settings-status">{statuses[item.id]?.state === "enabled" ? "已启用" : statuses[item.id]?.state === "loading" ? "正在加载…" : statuses[item.id]?.state === "error" ? "加载失败" : "已导入，待加载"}</span>
            {statuses[item.id]?.state !== "enabled" && statuses[item.id]?.state !== "loading" && statuses[item.id]?.canRetry !== false && <Button disabled={busy}
              onClick={() => {setBusy(true); setFailure(""); void plugins.enable(item.id).catch(error => setFailure(message(error))).finally(() => setBusy(false));}}>加载</Button>}
            {statuses[item.id]?.pages?.map(page => <Button key={page.id} disabled={busy}
              onClick={() => {void openPage(page.id);}}>打开{page.label}</Button>)}
          </div>
        </li>)}
      </ul>}
    </section>
  </div>;
}
