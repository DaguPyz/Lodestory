import {useRef, useSyncExternalStore, type ReactNode} from "react";
import {Dialog, DialogActions, DialogClose} from "@lodestory/ui";
import type {ErrorUiService} from "@lodestory/sdk/error";
import type {SettingsSection} from "@lodestory/sdk/settings";
import type {SettingsStore} from "./settingsStore";
import "./settings-dialog.css";

function SectionContent({section}: {section: SettingsSection}) {
  return section.render();
}

export function SettingsDialog({store, ErrorBoundary, children}: {
  store: SettingsStore;
  ErrorBoundary: ErrorUiService["ErrorBoundary"];
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const selected = snapshot.sections.find(section => section.id === snapshot.selectedId);
  const groups = new Map<string, SettingsSection[]>();
  for (const section of snapshot.sections) {
    const group = groups.get(section.group) ?? [];
    group.push(section);
    groups.set(section.group, group);
  }
  return <>
    {children}
    <Dialog open={snapshot.open} onOpenChange={next => { if (!next) store.close(); }}
      title="设置" size="large" bodyLayout="fill" initialFocus={selectedButton}>
      <div className="settings-dialog">
        <div className="settings-dialog-panels">
          <nav className="settings-navigation" aria-label="设置分类">
            {[...groups].map(([group, sections]) => <div className="settings-navigation-group" key={group}>
              <div className="settings-navigation-heading">{group}</div>
              <div className="settings-navigation-items">
                {sections.map(section => <button key={section.id} type="button" className="settings-navigation-item"
                  ref={section.id === selected?.id ? selectedButton : undefined}
                  aria-current={section.id === selected?.id ? "true" : undefined}
                  onClick={() => store.select(section.id)}>{section.title}</button>)}
              </div>
            </div>)}
          </nav>
          <section key={selected?.id ?? "empty"} className="settings-section" aria-labelledby="settings-section-title">
            {selected && <>
              <h2 id="settings-section-title" className="settings-section-title">{selected.title}</h2>
              <ErrorBoundary key={selected.id}><SectionContent section={selected}/></ErrorBoundary>
            </>}
          </section>
        </div>
        <div className="settings-dialog-footer"><DialogActions><DialogClose variant="secondary">关闭</DialogClose></DialogActions></div>
      </div>
    </Dialog>
  </>;
}
