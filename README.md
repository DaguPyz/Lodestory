# Lodestory

Tauri 2 desktop app with a React and TypeScript frontend.

## Development

Install [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```sh
pnpm install
pnpm dev:desktop
```

To build an application bundle:

```sh
pnpm tauri build
```

The bundle identifier is `com.lodestory.app` in `src-tauri/tauri.conf.json`.

Recent projects are saved by the Rust backend to `recent-projects.json` in the `Lodestory` folder under the system configuration directory. The previous `com.lodestory.app` configuration folder is renamed automatically on startup when the new folder does not exist. See [项目索引存储](文档/需求设计/欢迎页/项目索引存储.md) for the schema and behavior.

The workspace's **+** action creates a real Markdown document in the chosen project folder and opens it for writing. The file tree reads Markdown and text documents from disk; edits autosave and support `Cmd/Ctrl+S`. Existing files are protected from duplicate creation and external-change conflicts. See [文件目录树与新建文档](文档/需求设计/文件目录树.md).

Run frontend and storage checks with:

```sh
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

The development-only `/tests/fixtures/project-index.html` page uses Tauri IPC mocks to verify project-entry UI without modifying real directories or the index. Add `?scenario=cancel` or `?scenario=corrupt` to check cancellation and error states. Native directory dialogs require separate desktop validation.

The same fixture also supports document creation and writing; `?scenario=create-error`, `?scenario=save-error`, and `?scenario=slow-save` exercise document failure and pending-save flows without touching actual files.

The public plugin contracts live in [`@lodestory/sdk`](packages/sdk/README.md), an independent ESM package with core, UI, error, config, theme, layout, workbench, and documents entry points. The app consumes it through the pnpm workspace. Dynamic plugin loading and marketplace installation are planned separately.

The editor workbench provides `workbenchKey` for project sessions and coordinated leave checks; `default-layout` provides `layoutKey` for arranging the editor's main, navigation, auxiliary, actions, and status contents. The `workbench-toolbar` plugin contributes the top toolbar and uses the existing workbench, UI, and layout services. See [工作台插件设计](文档/需求设计/工作台插件.md), [工作台工具栏插件设计](文档/需求设计/工作台工具栏插件.md), and [布局插件设计](文档/需求设计/布局插件.md). The project fixture supports `?layout=alternative` for replacement verification and `?layout=probes` for multiple contributions and hidden-state checks.

Theme behavior and implementation boundaries are documented in [主题管理设计](文档/需求设计/主题管理.md). Theme authors and UI plugins share [主题标准 v1](文档/主题标准-v1.md) and its [颜色角色登记表](文档/主题标准-v1/颜色角色登记表.md). Regenerate the authoring reference with `pnpm generate:theme-docs` and verify the contract with `pnpm check:theme-standard`.

The `config` plugin provides typed application settings through `configKey`. It owns the base config file and local user overrides; the SDK contract does not prescribe a storage backend. The first integration selects the UI startup page through `ui.initialPage`. See [配置插件设计](文档/需求设计/配置插件.md). Existing theme preferences remain in the theme plugin and are not migrated by this change.

The `theme` plugin owns the color standard, resolution, selection, and synchronization. The separate `builtin-themes` plugin uses the same `registerTheme` API and cleanup lifecycle as custom contributors. Default and fallback IDs are configured in `src/plugins/theme/theme-config.json`; UI mounting waits until initial contributions and theme preparation are complete.

The `documents` plugin owns opened document content, selection, autosave, and save checks for each workbench session. The independent `project-management` plugin owns the project file tree, directory listing, and new-document dialog; it uses the documents service for file operations and registers its tree with the layout service. `body-editor` provides the document editor and writing status, `workbench-toolbar` provides the top toolbar, and `editor-features` temporarily retains the reference panel placeholder. Project-management implementation lives in `src/plugins/project-management/` and adds no SDK service. See [文档管理插件设计](文档/需求设计/文档管理插件.md), [工程管理插件设计](文档/需求设计/工程管理插件.md), and [工作台工具栏插件设计](文档/需求设计/工作台工具栏插件.md).
