import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { WelcomePage, type WelcomeSection } from "./pages/WelcomePage";
import { EditorPage } from "./pages/editor/EditorPage";
import type { ProjectRecord } from "./projects/projectApi";
import { useContextMenus } from "./plugins/context-menu";

export default function App() {
  const menus = useContextMenus();
  const [view, setView] = useState<"welcome" | "editor">("welcome");
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [welcomeSection, setWelcomeSection] = useState<WelcomeSection>("projects");
  const [settingsReturn, setSettingsReturn] = useState<"welcome" | "editor">("welcome");

  useEffect(() => { menus.closeAll(); }, [menus, view, welcomeSection, project]);

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
