import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { useThemeService } from "../theme/ThemeProvider";
import type { ResolvedTheme, ThemePreference } from "@lodestory/sdk/theme";
import { ProjectPageLayout } from "../../components/ProjectPageLayout";

function ThemePreview({ theme }: { theme: ResolvedTheme }) {
  return (
    <span className="theme-preview" data-ui-theme={theme.type} data-ui-theme-id={theme.id} style={theme.cssVariables as CSSProperties} aria-hidden="true">
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

type ThemeSettingsPageProps = {
  active: boolean;
  onBack: () => void;
};

export function ThemeSettingsPage({ active, onBack }: ThemeSettingsPageProps) {
  const service = useThemeService();
  const heading = useRef<HTMLHeadingElement>(null);
  const { preference, theme, themes, defaultThemeIds, unavailableThemeId, persistenceError, windowError } = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
  const systemPreference: Extract<ThemePreference, { mode: "system" }> = preference.mode === "system" ? preference : {
    mode: "system", lightThemeId: defaultThemeIds.light, darkThemeId: defaultThemeIds.dark,
  };
  const systemLight = themes.find(item => item.id === systemPreference.lightThemeId && item.type === "light") ?? themes.find(item => item.id === defaultThemeIds.light)!;
  const systemDark = themes.find(item => item.id === systemPreference.darkThemeId && item.type === "dark") ?? themes.find(item => item.id === defaultThemeIds.dark)!;

  useEffect(() => {
    if (active) heading.current?.focus({ preventScroll: true });
  }, [active]);

  return (
    <ProjectPageLayout section="settings" onOpenProjects={onBack} onOpenSettings={() => {}}>
      <main className="welcome-workspace appearance-workspace" aria-labelledby="appearance-page-heading">
        <div className="appearance-content">
          <header className="welcome-header">
            <div className="welcome-heading">
              <h1 id="appearance-page-heading" ref={heading} tabIndex={-1}>设置</h1>
              <p>让工作空间适合你的创作习惯。</p>
            </div>
            <Button variant="ghost" onClick={onBack}><Icon name="arrowLeft" />返回</Button>
          </header>

          <section className="appearance-section" aria-labelledby="appearance-section-heading">
            <h2 id="appearance-section-heading">外观</h2>
            <fieldset className="theme-fieldset" aria-describedby="theme-description">
              <legend>主题</legend>
              <p className="theme-description" id="theme-description">选择适合你的界面配色，切换即刻生效。</p>
              <div className="theme-options">
                {themes.map(option => {
                  const selected = preference.mode === "fixed" && preference.themeId === option.id;
                  return (
                    <label className="theme-option" key={option.id}>
                      <input
                        className="theme-option-input"
                        type="radio"
                        name="appearance-theme"
                        value={option.id}
                        checked={selected}
                        onChange={() => service.setPreference({ mode: "fixed", themeId: option.id })}
                        aria-labelledby={`theme-name-${option.id}`}
                        aria-describedby={`theme-caption-${option.id}`}
                      />
                      <ThemePreview theme={option} />
                      <span className="theme-option-body">
                        <span className="theme-option-heading">
                          <span className="theme-radio" aria-hidden="true">{selected && <Icon name="check" size="small" />}</span>
                          <span className="theme-option-name" id={`theme-name-${option.id}`}>{option.name}</span>
                        </span>
                        <span className="theme-option-description" id={`theme-caption-${option.id}`}>{option.type === "dark" ? "深色外观" : "浅色外观"}</span>
                      </span>
                    </label>
                  );
                })}
                <label className="theme-option">
                  <input
                    className="theme-option-input" type="radio" name="appearance-theme" value="system"
                    checked={preference.mode === "system"}
                    onChange={() => service.setPreference({ mode: "system", lightThemeId: systemLight.id, darkThemeId: systemDark.id })}
                    aria-labelledby="theme-name-system" aria-describedby="theme-caption-system"
                  />
                  <span className="theme-preview-split" aria-hidden="true">
                    <ThemePreview theme={systemLight} />
                    <ThemePreview theme={systemDark} />
                    <span className="theme-preview-system-icon"><Icon name="monitor" size="small" /></span>
                  </span>
                  <span className="theme-option-body">
                    <span className="theme-option-heading">
                      <span className="theme-radio" aria-hidden="true">{preference.mode === "system" && <Icon name="check" size="small" />}</span>
                      <span className="theme-option-name" id="theme-name-system">跟随系统</span>
                    </span>
                    <span className="theme-option-description" id="theme-caption-system">随操作系统的外观自动切换。</span>
                  </span>
                </label>
              </div>
              {preference.mode === "system" && (
                <div className="theme-system-choices">
                  {(["light", "dark"] as const).map(type => {
                    const slot = type === "light" ? "lightThemeId" : "darkThemeId";
                    return (
                      <label key={type}>
                        <span>系统为{type === "light" ? "浅色" : "深色"}时</span>
                        <select value={preference[slot]} onChange={event => service.setPreference({ mode: "system", lightThemeId: systemLight.id, darkThemeId: systemDark.id, [slot]: event.target.value })}>
                          {!themes.some(item => item.id === preference[slot] && item.type === type) && <option value={preference[slot]} disabled>主题暂不可用</option>}
                          {themes.filter(item => item.type === type).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="theme-current" role="status">当前使用「{theme.name}」{preference.mode === "system" ? "，跟随系统外观" : ""}。</p>
              {unavailableThemeId && <p className="theme-current" role="status">所选主题暂不可用，正在使用「{theme.name}」。主题恢复后会自动切回。</p>}
            </fieldset>
            <p className="theme-saving-note">选择后自动保存，所有项目共用此设置。</p>
            {(persistenceError || windowError) && (
              <div className="theme-error" role="alert">
                <div>
                  {persistenceError && <p>主题设置未能保存，下次启动可能恢复原设置。</p>}
                  {windowError && <p>窗口外观未能同步。</p>}
                </div>
                <Button variant="ghost" onClick={() => service.retry()}>重试</Button>
              </div>
            )}
          </section>
        </div>
        <footer className="welcome-footer">一个目录，一部小说。</footer>
      </main>
    </ProjectPageLayout>
  );
}
