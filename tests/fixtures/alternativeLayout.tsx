import {useSyncExternalStore} from "react";
import type {Plugin} from "@lodestory/sdk";
import {layoutKey, type LayoutContent, type LayoutService, type LayoutSnapshot} from "@lodestory/sdk/layout";
import {uiKey} from "@lodestory/sdk/ui";

/** 仅用于验证替换：不导入默认布局、编辑页或其状态，导航放在主内容之后。 */
export function createAlternativeLayoutPlugin(): Plugin {
  let cleanup: (() => void) | undefined;
  return {
    id: "test-alternative-layout", requires: [uiKey], provides: [layoutKey],
    activate(context) {
      const entries = new Map<string, LayoutContent>();
      const hidden = new Set<string>();
      const listeners = new Set<() => void>();
      let ready = false;
      let alive = true;
      let snapshot: LayoutSnapshot = Object.freeze({contents: [], shownIds: []});
      let removeWrapper: (() => void) | undefined;
      const check = () => { if (!alive) throw new Error("Alternative layout stopped"); };
      function publish() {
        const roles = ["actions", "main", "navigation", "auxiliary", "status"];
        const contents = [...entries.values()].sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role)
          || (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        snapshot = Object.freeze({contents: Object.freeze(contents), shownIds: Object.freeze(contents.filter(entry => !hidden.has(entry.id)).map(entry => entry.id))});
        for (const listener of listeners) listener();
      }
      const service: LayoutService = {
        View({active}) {
          const state = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
          return <div style={{flex: 1, minHeight: 0, overflow: "auto", padding: "1rem"}}>
            <h1>替换布局验证：按用途纵向排列</h1>
            <nav aria-label="替换布局内容入口">
              {state.contents.map(entry => <button key={entry.id} onClick={() => state.shownIds.includes(entry.id) ? service.hide(entry.id) : service.show(entry.id)}>
                {state.shownIds.includes(entry.id) ? "隐藏" : "显示"}{entry.title}
              </button>)}
            </nav>
            {state.contents.map(entry => <section key={entry.id} hidden={!state.shownIds.includes(entry.id)}
              data-alternative-content={entry.id} aria-label={entry.title} style={{minHeight: "3rem", borderBottom: "1px solid var(--ui-border-divider)"}}>
              <Content entry={entry} active={active && state.shownIds.includes(entry.id)}/>
            </section>)}
          </div>;
        },
        registerContent(input) {
          check();
          if (ready || entries.has(input.id)) throw new Error("Invalid alternative layout registration");
          const entry = Object.freeze({...input});
          entries.set(entry.id, entry); publish();
          return () => {
            if (!alive || entries.get(entry.id) !== entry) return;
            try { if (ready) removeWrapper?.(); }
            finally { entries.delete(entry.id); hidden.delete(entry.id); publish(); }
          };
        },
        show(id) { check(); if (!entries.has(id)) throw new Error("Unknown content"); if (hidden.delete(id)) publish(); },
        hide(id) { check(); if (!entries.has(id)) throw new Error("Unknown content"); if (!hidden.has(id)) { hidden.add(id); publish(); } },
        getSnapshot() { check(); return snapshot; },
        subscribe(listener) { check(); listeners.add(listener); return () => { listeners.delete(listener); }; },
      };
      cleanup = () => { try { removeWrapper?.(); } finally { alive = false; entries.clear(); listeners.clear(); } };
      context.provide(layoutKey, service);
      removeWrapper = context.get(uiKey).addWrapper({id: "test-alternative-layout", order: 30, prepare() {ready = true;}, wrap: children => children});
    },
    deactivate() { const stop = cleanup; cleanup = undefined; stop?.(); },
  };
}

function Content({entry, active}: {entry: LayoutContent; active: boolean}) { return entry.render({active}); }
