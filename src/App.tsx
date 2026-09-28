import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { startThemeSync, whenNativeThemeReady } from "./theme/themeStore";
import { WelcomePage } from "./pages/WelcomePage";

export default function App() {
  const [themeReady, setThemeReady] = useState(() => !isTauri());

  useEffect(() => {
    let active = true;
    const stop = startThemeSync();
    void whenNativeThemeReady().then(() => {
      if (active) setThemeReady(true);
    });
    return () => {
      active = false;
      stop();
    };
  }, []);

  if (!themeReady) return null;

  return (
    <div className="app-shell">
      {!isTauri() && <header className="window-titlebar">Lodestory</header>}
      <WelcomePage />
    </div>
  );
}
