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
