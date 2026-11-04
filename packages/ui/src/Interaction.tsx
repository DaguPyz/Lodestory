import {createContext, useCallback, useContext, type ReactNode, type RefCallback} from "react";

/** A surface which has entered an interactive state. */
export type InteractionTarget = Readonly<{element: HTMLElement; kind: string}>;
/** The returned function is called when that surface is no longer interactive. */
export type InteractionObserver = (target: InteractionTarget) => () => void;

const InteractionContext = createContext<InteractionObserver | null>(null);

/** An application may observe component interactions without supplying its services to the library. */
export function InteractionProvider({onActivate, children}: {onActivate: InteractionObserver; children: ReactNode}) {
  return <InteractionContext.Provider value={onActivate}>{children}</InteractionContext.Provider>;
}

/** Attach to an interactive surface; also available to independently implemented controls. */
export function useInteractionRef<T extends HTMLElement>(active: boolean, kind: string): RefCallback<T> {
  const onActivate = useContext(InteractionContext);
  return useCallback(element => {
    if (active && element && onActivate) return onActivate({element, kind});
  }, [active, kind, onActivate]);
}

