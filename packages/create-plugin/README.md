# Lodestory 插件项目脚手架

脚手架生成独立的插件开发项目，可选择仅前端、仅后端或前后端都有。Rust 后端可以是独立程序（C）或动态库（D）。

包名以实际发布结果为准。发布后，计划运行：

```sh
npx @lodestory/create-plugin
```

按提示选择项目组成、后端类型、项目名和插件 ID。发布前，可在 Lodestory 仓库根目录运行 `node packages/create-plugin/bin/create-plugin.mjs`。

也可以直接传入参数：

```sh
node packages/create-plugin/bin/create-plugin.mjs --name my-front --frontend --id com.example.my-front
node packages/create-plugin/bin/create-plugin.mjs --name my-c --type process --id com.example.my-c
node packages/create-plugin/bin/create-plugin.mjs --name my-both --frontend --type dynamic-library --id com.example.my-both
```

默认在当前目录创建与项目名相同的目录；`--output` 可指定其他目标路径。目标路径必须不存在，其父目录必须已存在。项目名须以小写英文字母开头，最多 64 个字符，只包含小写字母、数字、连字符或下划线，且不能使用 Rust 或 Cargo 的保留名称。插件 ID 当前按至少两段点分隔的英文、数字、下划线或连字符校验；此规则和示例 ID 仍需与正式外部插件规范统一。

## 生成项目和交付包

项目中的 `plugin.json` 由开发者维护，记录插件身份、兼容范围、依赖和前后端选择。安装依赖后，`package.json` 提供构建及打包命令：

```sh
npm run build
npm run package
```

`build` 将本次结果写入 `build/run-*`；`package` 会重新构建，并在 `release/` 生成 ZIP。打包工具根据 `plugin.json` 和实际产物生成 ZIP 根目录内的 `manifest.json`；开发者不需要手写交付清单。同名 ZIP 不会被覆盖。

前端使用 React，按公开 SDK 契约登记工作台内容，React 和 `@lodestory/sdk` 保留为外部依赖，由未来宿主提供同一实例。前端源码位于 `frontend/src`；可把静态文件放在 `frontend/assets`，引用的样式和图片等资源也会一起打包。生成的样式文件会记录在交付清单的 `frontend.styles` 中。

后端源码位于 `backend`。打包时按当前 Rust 工具链的宿主目标编译，把真实文件路径、系统、处理器和 Rust 目标三元组写进清单；一个后端包对应一个目标。构建含后端项目需要 Rust 和 Cargo。目标识别覆盖 macOS、Windows 和 Linux 的 x64、arm64；目前桌面联调只在 macOS arm64 完成。

脚手架使用 Node.js 18 或更新版本。默认插件 ID、宿主接口版本和跨包能力 ID 均为示例，正式发布前须按正式契约修改 `plugin.json`。仅后端项目可直接运行 `npm install`。`@lodestory/sdk` 尚未发布到 npm：在发布前，含前端项目需要先本地打包 SDK，并在生成项目中安装该 SDK 包及其他构建依赖。

例如，在 Lodestory 仓库内执行 `npm pack ./packages/sdk --pack-destination /SDK包目录`，再在生成的插件项目内执行 `npm install --save-dev /SDK包目录/lodestory-sdk-0.1.0.tgz`。本地安装会更新该项目的 SDK 依赖路径；SDK 正式发布后可改回版本号。

当前 Lodestory 尚未实现外部插件安装、前端动态加载、按清单选择 A/B 或前后端的统一连接接口；生成的 ZIP 暂不能直接安装，清单与入口仍是待联调的方案。
