import type {Plugin} from "@lodestory/sdk";
import {projectSearchKey, projectSearchRequested} from "@lodestory/sdk/project-search";
import {uiKey} from "@lodestory/sdk/ui";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {createSearchIndex} from "./searchIndex";
import {ProjectSearch} from "./ProjectSearch";

export function createProjectSearchPlugin(): Plugin {
  let dispose: (() => void) | undefined;
  return {
    id: "project-search", requires: [uiKey, workbenchKey], provides: [projectSearchKey],
    activate(context) {
      const ui = context.get(uiKey), workbench = context.get(workbenchKey);
      const index = createSearchIndex();
      const listeners = new Set<(id: string) => void>();
      const requests = {subscribe(listener: (id: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }};
      let removeWrapper: (() => void) | undefined;
      let removeEvent: (() => void) | undefined;
      dispose = () => { removeWrapper?.(); removeEvent?.(); listeners.clear(); index.dispose(); };
      context.provide(projectSearchKey, index);
      removeEvent = context.on(projectSearchRequested, request => {
        const state = workbench.getSnapshot();
        if (state.session?.id === request.sessionId && state.active && !state.busy) for (const listener of [...listeners]) listener(request.sessionId);
      });
      removeWrapper = ui.addWrapper({id: "project-search.dialog", order: 50,
        wrap: children => <>{children}<ProjectSearch search={index} workbench={workbench} requests={requests}/></>});
    },
    deactivate() { const stop = dispose; dispose = undefined; stop?.(); },
  };
}
