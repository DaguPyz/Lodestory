export default function Panel({active}: {active: boolean}) {
  return <section aria-hidden={!active}>
    <h1>插件示例</h1>
    <p>在这里开发你的界面。</p>
  </section>;
}
