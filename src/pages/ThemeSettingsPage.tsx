import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { retryTheme, setThemeMode, type ResolvedTheme, type ThemeMode } from "../plugins/theme/themeStore";
import { useTheme } from "../plugins/theme/useTheme";

const options: { mode: ThemeMode; label: string; description: string }[] = [
  { mode: "dark", label: "深色", description: "沉静柔和，让内容成为焦点。" },
  { mode: "light", label: "浅色", description: "明亮清爽，清晰呈现每个细节。" },
  { mode: "system", label: "跟随系统", description: "随操作系统的外观自动切换。" },
];

function ThemePreview({ theme }: { theme: ResolvedTheme }) {
  return (
    <span className="theme-preview" data-ui-theme={theme} aria-hidden="true">
      <span className="theme-preview-sidebar">
        <Icon name="book" size="small" />
        <span className="theme-preview-navigation"><Icon name="folder" size="small" /></span>
        <span className="theme-preview-settings"><Icon name="settings" size="small" /></span>
      </span>
      <span className="theme-preview-main">
        <span className="theme-preview-heading">Lodestory</span>
        <span className="theme-preview-caption">最近项目</span>
        <span className="theme-preview-project"><Icon name="folder" size="small" /><span /></span>
        <span className="theme-preview-project"><Icon name="folder" size="small" /><span /></span>
        <span className="theme-preview-action" />
      </span>
    </span>
  );
}

function SystemPreview() {
  return (
    <span className="theme-preview-split" aria-hidden="true">
      <ThemePreview theme="light" />
      <ThemePreview theme="dark" />
      <span className="theme-preview-system-icon"><Icon name="monitor" size="small" /></span>
    </span>
  );
}

type ThemeSettingsPageProps = {
  visible: boolean;
  onBack: () => void;
};

export function ThemeSettingsPage({ visible, onBack }: ThemeSettingsPageProps) {
  const { mode, resolvedTheme, persistenceError, windowError } = useTheme();
  const currentLabel = resolvedTheme === "dark" ? "深色" : "浅色";

  return (
    <main
      className="welcome-workspace appearance-workspace"
      hidden={!visible}
      aria-labelledby="appearance-page-heading"
    >
      <div className="appearance-content">
        <header className="welcome-header">
          <div className="welcome-heading">
            <h1 id="appearance-page-heading" tabIndex={-1}>设置</h1>
            <p>让工作空间适合你的创作习惯。</p>
          </div>
          <Button variant="ghost" onClick={onBack}><Icon name="arrowLeft" />返回项目</Button>
        </header>

        <section className="appearance-section" aria-labelledby="appearance-section-heading">
          <h2 id="appearance-section-heading">外观</h2>

          <fieldset className="theme-fieldset" aria-describedby="theme-description">
            <legend>主题</legend>
            <p className="theme-description" id="theme-description">选择适合你的界面配色，切换即刻生效。</p>

            <div className="theme-options">
              {options.map((option) => (
                <label className="theme-option" key={option.mode}>
                  <input
                    className="theme-option-input"
                    type="radio"
                    name="appearance-theme"
                    value={option.mode}
                    checked={mode === option.mode}
                    onChange={() => setThemeMode(option.mode)}
                    aria-labelledby={`theme-name-${option.mode}`}
                    aria-describedby={`theme-caption-${option.mode}`}
                  />
                  {option.mode === "system" ? <SystemPreview /> : <ThemePreview theme={option.mode} />}
                  <span className="theme-option-body">
                    <span className="theme-option-heading">
                      <span className="theme-radio" aria-hidden="true">
                        {mode === option.mode && <Icon name="check" size="small" />}
                      </span>
                      <span className="theme-option-name" id={`theme-name-${option.mode}`}>{option.label}</span>
                      {option.mode === "dark" && <span className="theme-option-default">默认</span>}
                    </span>
                    <span className="theme-option-description" id={`theme-caption-${option.mode}`}>{option.description}</span>
                  </span>
                </label>
              ))}
            </div>

            <p className="theme-current" role="status">
              当前使用{currentLabel}主题{mode === "system" ? "，跟随系统外观" : ""}。
            </p>
          </fieldset>

          <p className="theme-saving-note">选择后自动保存，所有项目共用此设置。</p>

          {(persistenceError || windowError) && (
            <div className="theme-error" role="alert">
              <div>
                {persistenceError && <p>主题设置未能保存，下次启动可能恢复原设置。</p>}
                {windowError && <p>窗口外观未能同步。</p>}
              </div>
              <Button variant="ghost" onClick={retryTheme}>重试</Button>
            </div>
          )}
        </section>
      </div>

      <footer className="welcome-footer">一个目录，一部小说。</footer>
    </main>
  );
}
