import type {Plugin} from "@lodestory/sdk";
import {projectSearchKey, projectSearchRequested} from "@lodestory/sdk/project-search";
import {uiKey} from "@lodestory/sdk/ui";
import {workbenchKey} from "@lodestory/sdk/workbench";
import {shortcutsKey, shortcutCommandIds, shortcutScopeIds} from "@lodestory/sdk/shortcuts";
import {createSearchIndex} from "./searchIndex";
import {ProjectSearch} from "./ProjectSearch";

export function createProjectSearchPlugin(): Plugin {
  let dispose: (() => void) | undefined;
  return {
    id: "project-search", requires: [uiKey, workbenchKey, shortcutsKey], provides: [projectSearchKey],
    activate(context) {
      const ui = context.get(uiKey), workbench = context.get(workbenchKey);
      const shortcuts = context.get(shortcutsKey);
      const index = createSearchIndex();
      const listeners = new Set<(id: string) => void>();
      const requests = {subscribe(listener: (id: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }};
      let removeWrapper: (() => void) | undefined;
      let removeEvent: (() => void) | undefined;
      const removers: (() => void)[] = [];
      dispose = () => {
        const errors: unknown[] = [];
        for (const remove of [removeWrapper, removeEvent, ...removers.splice(0).reverse()]) {
          try { remove?.(); } catch (error) { errors.push(error); }
        }
        removeWrapper = undefined;
        removeEvent = undefined;
        listeners.clear();
        try { index.dispose(); } catch (error) { errors.push(error); }
        if (errors.length) throw Object.assign(new Error("Project search failed to stop."), {errors});
      };
      context.provide(projectSearchKey, index);
      const canOpen = (args: unknown) => {
        const state = workbench.getSnapshot();
        if (!state.session || !state.active || state.busy) return false;
        if (args === undefined) return true;
        if (!args || typeof args !== "object" || !("sessionId" in args)) return false;
        return typeof args.sessionId === "string" && args.sessionId === state.session.id;
      };
      try {
        removers.push(shortcuts.registerCommand({
          id: shortcutCommandIds.projectSearch,
          title: "搜索项目资源",
          category: "项目",
          enabled: ({args}) => canOpen(args),
          run: ({args}) => {
            const request = args as {sessionId?: unknown} | undefined;
            const state = workbench.getSnapshot();
            const sessionId = request?.sessionId ?? state.session?.id;
            if (typeof sessionId !== "string" || state.session?.id !== sessionId || !state.active || state.busy) return;
            for (const listener of [...listeners]) listener(sessionId);
          },
        }));
        removers.push(shortcuts.registerBinding({id: "project-search.open", commandId: shortcutCommandIds.projectSearch,
          scopeId: shortcutScopeIds.workbench, keys: "Mod+Shift+F", allowInInput: true}));
      } catch (error) { for (const remove of removers.reverse()) remove(); throw error; }
      removeEvent = context.on(projectSearchRequested, request => {
        void shortcuts.execute(shortcutCommandIds.projectSearch, request).catch(error => console.error("Could not execute project search.", error));
      });
      removeWrapper = context.track(ui.addWrapper({id: "project-search.dialog", order: 50,
        wrap: children => <>{children}<ProjectSearch search={index} workbench={workbench} requests={requests}/></>}));
    },
    deactivate() { const stop = dispose; dispose = undefined; stop?.(); },
  };
}
