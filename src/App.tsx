import { isTauri } from "@tauri-apps/api/core";
import { WelcomePage } from "./pages/WelcomePage";

export default function App() {
  return (
    <div className="app-shell">
      {!isTauri() && <header className="window-titlebar">Lodestory</header>}
      <WelcomePage />
    </div>
  );
}
