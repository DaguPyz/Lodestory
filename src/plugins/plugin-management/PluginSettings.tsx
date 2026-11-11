import {useEffect, useState} from "react";
import {Button} from "@lodestory/ui";
import type {ImportedPluginPackage, PluginPackagesService} from "@lodestory/sdk/plugin-packages";
import "./plugin-settings.css";

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "无法读取插件，请重试。";
}

export function PluginSettings({packages}: {packages: PluginPackagesService}) {
  const [items, setItems] = useState<readonly ImportedPluginPackage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [refresh, setRefresh] = useState(0);

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
      await packages.importFromFile();
    } catch (error) {setFailure(message(error));}
    finally {setBusy(false);}
  }

  return <div className="plugin-settings">
    <p className="plugin-settings-description">导入本地插件包。插件暂不能加载或使用。</p>
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
          <div className="plugin-settings-identity"><strong>{item.name}</strong><span>{item.id} · {item.version}</span></div>
          <span className="plugin-settings-status">已导入，待加载</span>
        </li>)}
      </ul>}
    </section>
  </div>;
}
