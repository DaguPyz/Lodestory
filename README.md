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
