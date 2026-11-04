import type {ReactNode} from "react";
import {InteractionProvider, type InteractionObserver} from "@lodestory/ui";
import type {Plugin} from "@lodestory/sdk";
import {uiInteractionKey, uiKey, type UiInteractionService} from "@lodestory/sdk/ui";

/** Connects generic component notifications to this UI instance. */
export function createUiInteractionPlugin(): Plugin {
  let cleanup: (() => void) | undefined;
  return {
    id: "ui-interaction",
    requires: [uiKey],
    provides: [uiInteractionKey],
    activate(context) {
      const ui = context.get(uiKey);
      const registrations = new Set<() => void>();
      let active = true;
      let removeWrapper: (() => void) | undefined;
      const onActivate: InteractionObserver = ({element}) => {
        if (!active) return () => {};
        const remove = ui.registerOverlay(element);
        let registered = true;
        const release = () => {
          if (!registered) return;
          registered = false;
          registrations.delete(release);
          remove();
        };
        registrations.add(release);
        return release;
      };
      const wrap = (children: ReactNode) => <InteractionProvider onActivate={onActivate}>{children}</InteractionProvider>;
      const service: UiInteractionService = Object.freeze({
        wrap,
        hasActiveOverlay: () => active && ui.hasActiveOverlay(),
      });
      cleanup = () => {
        const errors: unknown[] = [];
        try { removeWrapper?.(); } catch (error) { errors.push(error); }
        active = false;
        for (const release of [...registrations]) {
          try { release(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw Object.assign(new Error("UI interaction bridge failed to stop."), {errors});
      };
      context.provide(uiInteractionKey, service);
      removeWrapper = ui.addWrapper({id: "ui-interaction", order: 0, wrap});
    },
    deactivate() { const stop = cleanup; cleanup = undefined; stop?.(); },
  };
}
