export function UiErrorPage() {
    return <main className="app-startup-error" role="alert">
        <h1>界面显示失败</h1>
        <p>无法显示当前界面，请重新加载应用。</p>
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
    </main>;
}
