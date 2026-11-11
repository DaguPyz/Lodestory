import {useState} from "react";
import type {PluginBackend} from "@lodestory/sdk/external-plugins";

export default function Panel({active, backend}: {active: boolean; backend?: PluginBackend}) {
  const [result, setResult] = useState("");
  async function ping() {
    if (!backend) return;
    try {
      const response = await backend.call({requestId: crypto.randomUUID(), operation: "ping", schemaVersion: "1.0.0", params: {text: "来自插件前端"}});
      setResult(response.status === "success" ? "后端已收到请求" : response.error.message);
    } catch (error) {setResult(error instanceof Error ? error.message : String(error));}
  }
  return <section aria-hidden={!active}>
    <h1>插件示例</h1>
    <p>在这里开发你的界面。</p>
    {backend && <button type="button" onClick={() => {void ping();}}>测试后端</button>}
    {result && <p role="status">{result}</p>}
  </section>;
}
