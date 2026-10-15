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

The public plugin contracts live in [`@lodestory/sdk`](packages/sdk/README.md), an independent ESM package with core, UI, and theme entry points. The app consumes it through the pnpm workspace. Dynamic plugin loading and marketplace installation are planned separately.

Theme behavior and implementation boundaries are documented in [主题管理设计](文档/需求设计/主题管理.md). Theme authors and UI plugins share [主题标准 v1](文档/主题标准-v1.md) and its [颜色角色登记表](文档/主题标准-v1/颜色角色登记表.md). Regenerate the authoring reference with `pnpm generate:theme-docs` and verify the contract with `pnpm check:theme-standard`.

The `theme` plugin owns the color standard, resolution, selection, and synchronization. The separate `builtin-themes` plugin contributes the default palettes through the SDK; both built-in and custom themes appear in the same catalog.
