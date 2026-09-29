import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { startThemeSync, whenNativeThemeReady } from "./theme/themeStore";
import { WelcomePage, type WelcomeSection } from "./pages/WelcomePage";
import { EditorPage } from "./pages/editor/EditorPage";
import type { ProjectRecord } from "./projects/projectApi";

export default function App() {
  const [themeReady, setThemeReady] = useState(() => !isTauri());
  const [view, setView] = useState<"welcome" | "editor">("welcome");
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [welcomeSection, setWelcomeSection] = useState<WelcomeSection>("projects");
  const [settingsReturn, setSettingsReturn] = useState<"welcome" | "editor">("welcome");

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

  function focusEditor() {
    requestAnimationFrame(() => {
      const title = document.querySelector<HTMLElement>(".editor-document:not([hidden]) .manuscript-title")
        ?? document.getElementById("editor-empty-title");
      title?.focus({ preventScroll: true });
    });
  }

  function openProject(project: ProjectRecord) {
    setProject(project);
    setSettingsReturn("welcome");
    setView("editor");
    focusEditor();
  }

  function returnToWelcome() {
    setWelcomeSection("projects");
    setSettingsReturn("welcome");
    setView("welcome");
    requestAnimationFrame(() => document.getElementById("welcome-page-heading")?.focus({ preventScroll: true }));
  }

  function openEditorSettings() {
    setSettingsReturn("editor");
    setWelcomeSection("settings");
    setView("welcome");
    requestAnimationFrame(() => document.getElementById("appearance-page-heading")?.focus({ preventScroll: true }));
  }

  function returnFromSettings() {
    if (settingsReturn === "editor") {
      setView("editor");
      focusEditor();
    } else {
      setWelcomeSection("projects");
      requestAnimationFrame(() => document.getElementById("welcome-page-heading")?.focus({ preventScroll: true }));
    }
    setSettingsReturn("welcome");
  }

  return (
    <div className="app-shell">
      {!isTauri() && view === "welcome" && <header className="window-titlebar">Lodestory</header>}
      <div className="app-view" hidden={view !== "welcome"}>
        <WelcomePage
          active={view === "welcome"}
          section={welcomeSection}
          onSectionChange={(section) => {
            setWelcomeSection(section);
            setSettingsReturn("welcome");
          }}
          onOpenProject={openProject}
          onBackFromSettings={returnFromSettings}
        />
      </div>
      {project && <div className="app-view" hidden={view !== "editor"}>
        <EditorPage
          key={`${project.id}:${project.path}`}
          projectName={project.name}
          projectPath={project.path}
          active={view === "editor"}
          onBack={returnToWelcome}
          onOpenSettings={openEditorSettings}
        />
      </div>}
    </div>
  );
}
