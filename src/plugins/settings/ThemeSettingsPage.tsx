import { useCallback, useEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { BrandLogo, Button, Icon, Select } from "@lodestory/ui";
import type { ResolvedTheme, ThemePreference, ThemeService } from "@lodestory/sdk/theme";
import type { ConfigService } from "@lodestory/sdk/config";
import { MotionSettings } from "./MotionSettings";
import "./theme-settings.css";

function ThemePreview({ theme }: { theme: ResolvedTheme }) {
  return (
    <span className="theme-preview" data-ui-theme={theme.type} data-ui-theme-id={theme.id} style={theme.cssVariables as CSSProperties} aria-hidden="true">
      <span className="theme-preview-sidebar">
        <BrandLogo size="small" />
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
  service: ThemeService;
  config: ConfigService;
  active: boolean;
  onBack: () => void;
};

export function ThemeSettingsPage({ service, config, active, onBack }: ThemeSettingsPageProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Wrap methods so ThemeService implementations may safely use `this`.
  const subscribe = useCallback((listener: () => void) => service.subscribe(listener), [service]);
  const getSnapshot = useCallback(() => service.getSnapshot(), [service]);
  const { preference, theme, themes, fallbackThemeIds, unavailableThemeId, persistenceError, windowError } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const systemPreference: Extract<ThemePreference, { mode: "system" }> = preference.mode === "system" ? preference : {
    mode: "system", lightThemeId: fallbackThemeIds.light, darkThemeId: fallbackThemeIds.dark,
  };
  const systemLight = themes.find(item => item.id === systemPreference.lightThemeId && item.type === "light") ?? themes.find(item => item.id === fallbackThemeIds.light && item.type === "light") ?? themes.find(item => item.type === "light");
  const systemDark = themes.find(item => item.id === systemPreference.darkThemeId && item.type === "dark") ?? themes.find(item => item.id === fallbackThemeIds.dark && item.type === "dark") ?? themes.find(item => item.type === "dark");

  useEffect(() => {
    if (active) heading.current?.focus({ preventScroll: true });
  }, [active]);

  return (
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
                          <span className="theme-radio" aria-hidden="true" />
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
                    disabled={!systemLight || !systemDark}
                    onChange={() => { if (systemLight && systemDark) service.setPreference({ mode: "system", lightThemeId: systemLight.id, darkThemeId: systemDark.id }); }}
                    aria-labelledby="theme-name-system" aria-describedby="theme-caption-system"
                  />
                  <span className="theme-preview-split" aria-hidden="true">
                    {systemLight && <ThemePreview theme={systemLight} />}
                    {systemDark && <ThemePreview theme={systemDark} />}
                    <span className="theme-preview-system-icon"><Icon name="monitor" size="small" /></span>
                  </span>
                  <span className="theme-option-body">
                    <span className="theme-option-heading">
                      <span className="theme-radio" aria-hidden="true" />
                      <span className="theme-option-name" id="theme-name-system">跟随系统</span>
                    </span>
                    <span className="theme-option-description" id="theme-caption-system">{systemLight && systemDark ? "随操作系统的外观自动切换。" : "需要已启用的深色和浅色主题。"}</span>
                  </span>
                </label>
              </div>
              {preference.mode === "system" && (
                <div className="theme-system-choices">
                  {(["light", "dark"] as const).map(type => {
                    const slot = type === "light" ? "lightThemeId" : "darkThemeId";
                    const labelId = `system-theme-${type}-label`;
                    const options = [
                      ...(!themes.some(item => item.id === preference[slot] && item.type === type)
                        ? [{value: preference[slot], label: "主题暂不可用", disabled: true}]
                        : []),
                      ...themes.filter(item => item.type === type).map(item => ({value: item.id, label: item.name})),
                    ];
                    return (
                      <div className="theme-system-choice" key={type}>
                        <span id={labelId}>系统为{type === "light" ? "浅色" : "深色"}时</span>
                        <Select aria-labelledby={labelId} value={preference[slot]} options={options}
                          disabled={!systemLight || !systemDark} onValueChange={value => {
                            if (systemLight && systemDark) service.setPreference({ mode: "system", lightThemeId: systemLight.id, darkThemeId: systemDark.id, [slot]: value });
                          }} />
                      </div>
                    );
                  })}
                </div>
              )}
              {theme ? <p className="theme-current" role="status">当前使用「{theme.name}」{preference.mode === "system" ? "，跟随系统外观" : ""}。</p> : <p className="theme-current" role="status">暂无可用主题，请启用主题插件。</p>}
              {unavailableThemeId && theme && <p className="theme-current" role="status">所选主题暂不可用，正在使用「{theme.name}」。主题恢复后会自动切回。</p>}
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
            <MotionSettings config={config} />
          </section>
        </div>
        <footer className="welcome-footer">一个目录，一部小说。</footer>
      </main>
  );
}
