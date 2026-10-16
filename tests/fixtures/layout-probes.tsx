import {useState} from "react";
import type {Plugin} from "@lodestory/sdk";
import {layoutKey, type LayoutRole} from "@lodestory/sdk/layout";

let instance = 0;
function Probe({active, role}: {active: boolean; role: string}) {
  const [instanceId] = useState(() => ++instance);
  const [draft, setDraft] = useState("");
  return <div data-layout-probe={role} data-instance={instanceId} data-active={String(active)}>
    <label>验证输入 {role}<input aria-label={`验证输入 ${role}`} value={draft} onChange={event => setDraft(event.target.value)}/></label>
    <output>{draft}</output>
  </div>;
}

/** 同用途第二项，验证默认布局无业务 ID 特判、隐藏保留实例以及 active 的传递。 */
export function createLayoutProbesPlugin(): Plugin {
  const removers: (() => void)[] = [];
  return {
    id: "test-layout-probes", requires: [layoutKey], provides: [],
    activate(context) {
      for (const role of ["main", "navigation", "auxiliary", "actions", "status"] satisfies LayoutRole[]) {
        removers.push(context.get(layoutKey).registerContent({
          id: `probe.${role}`, title: `验证 ${role}`, role, order: 100,
          render: ({active}) => <Probe role={role} active={active}/>,
        }));
      }
    },
    deactivate() { for (const remove of removers.splice(0).reverse()) remove(); },
  };
}
