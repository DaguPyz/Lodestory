import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createMenuCoordinator } from "./menuCoordinator";

const MenuContext = createContext<ReturnType<typeof createMenuCoordinator> | null>(null);

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [coordinator] = useState(createMenuCoordinator);
  useEffect(() => {
    const close = () => coordinator.closeAll();
    const visibility = () => { if (document.hidden) close(); };
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("visibilitychange", visibility);
      close();
    };
  }, [coordinator]);
  return <MenuContext.Provider value={coordinator}>{children}</MenuContext.Provider>;
}

export function useContextMenus() {
  const value = useContext(MenuContext);
  if (!value) throw new Error("ContextMenuRegion requires ContextMenuProvider at the window root.");
  return value;
}
