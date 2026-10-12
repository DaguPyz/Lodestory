import type {ReactNode} from "react";
import {Icon} from "./Icon";
import {PageShell} from "./PageShell";

type ProjectPageLayoutProps = {
  section: "projects" | "settings";
  onOpenProjects: () => void;
  onOpenSettings: () => void;
  children: ReactNode;
};

/** Shared navigation layout for the welcome and appearance pages. */
export function ProjectPageLayout({section, onOpenProjects, onOpenSettings, children}: ProjectPageLayoutProps) {
  return <PageShell>
    <div className="welcome-layout" data-ui-density="spacious">
      <aside className="navigation-panel" aria-label="应用导航">
        <div className="brand">
          <Icon name="book" size="brand" />
          <div className="brand-copy">
            <span className="brand-name">Lodestory</span>
            <span className="brand-caption">小说创作工作空间</span>
          </div>
        </div>

        <nav className="navigation-items" aria-label="主导航">
          <button
            className="navigation-item"
            type="button"
            aria-current={section === "projects" ? "page" : undefined}
            aria-label="作品"
            title="作品"
            onClick={onOpenProjects}
          >
            <Icon name="folder" />
            <span>作品</span>
          </button>
        </nav>

        <button
          className="navigation-item navigation-settings"
          type="button"
          aria-current={section === "settings" ? "page" : undefined}
          aria-label="设置"
          title="设置"
          onClick={onOpenSettings}
        >
          <Icon name="settings" />
          <span>设置</span>
        </button>
      </aside>
      {children}
    </div>
  </PageShell>;
}
