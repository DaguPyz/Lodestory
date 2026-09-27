import { Button, IconButton } from "../components/Button";
import { Icon } from "../components/Icon";
import { SearchField } from "../components/SearchField";

// Presentation samples only. No project files or business actions are accessed.
const previewProjects = [
  { id: "long-night", name: "长夜行舟", path: "~/Novels/长夜行舟", lastOpened: "今天 09:41" },
  { id: "sea-letter", name: "雾海来信", path: "~/Novels/雾海来信", lastOpened: "昨天 20:16" },
  { id: "old-stories", name: "山河旧事", path: "~/Novels/山河旧事", lastOpened: "9月25日" },
];

function ProjectPath({ path, id }: { path: string; id: string }) {
  const separator = path.lastIndexOf("/");

  return (
    <span className="project-path" id={id} title={path}>
      <span className="project-path-prefix">{separator < 0 ? "" : path.slice(0, separator)}</span>
      <span className="project-path-name">{separator < 0 ? path : path.slice(separator)}</span>
    </span>
  );
}

export function WelcomePage() {
  return (
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
          <button className="navigation-item" type="button" aria-current="page" aria-label="项目" title="项目">
            <Icon name="folder" />
            <span>项目</span>
          </button>
        </nav>

        <button className="navigation-item navigation-settings" type="button" aria-label="设置" title="设置">
          <Icon name="settings" />
          <span>设置</span>
        </button>
      </aside>

      <main className="welcome-workspace">
        <div className="welcome-content">
          <header className="welcome-header">
            <div className="welcome-heading">
              <h1>欢迎使用 Lodestory</h1>
              <p>继续写作，或开始一个新故事。</p>
            </div>
            <div className="welcome-actions" aria-label="项目操作">
              <Button variant="primary"><Icon name="plus" />新建项目</Button>
              <Button><Icon name="folder" />打开目录</Button>
            </div>
          </header>

          <section className="recent-projects" aria-labelledby="recent-projects-heading">
            <div className="section-toolbar">
              <h2 id="recent-projects-heading">最近项目</h2>
              <SearchField label="搜索项目" />
            </div>

            <ul className="project-list" aria-label="最近打开的小说项目">
              {previewProjects.map((project) => (
                <li className="project-row" key={project.id}>
                  <button
                    className="project-entry"
                    type="button"
                    aria-label={`打开项目 ${project.name}`}
                    aria-describedby={`project-path-${project.id}`}
                  >
                    <Icon name="folder" />
                    <span className="project-details">
                      <span className="project-name" title={project.name}>{project.name}</span>
                      <ProjectPath path={project.path} id={`project-path-${project.id}`} />
                    </span>
                    <span className="project-time">{project.lastOpened}</span>
                  </button>
                  <IconButton label={`${project.name}的更多操作`}>
                    <Icon name="more" />
                  </IconButton>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="welcome-footer">一个目录，一部小说。</footer>
      </main>
    </div>
  );
}

