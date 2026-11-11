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

默认在当前目录创建与项目名相同的目录；`--output` 可指定其他目标路径。目标路径必须不存在，其父目录必须已存在。项目名须以小写英文字母开头，最多 64 个字符，只包含小写字母、数字、连字符或下划线，且不能使用 Rust 或 Cargo 的保留名称。插件 ID 至少两段，以点分隔，每段使用英文、数字、下划线或连字符；默认的 `com.example` 命名空间仅作示例，发布前应改为自己的 ID。

## 生成项目和交付包

项目中的 `plugin.json` 由开发者维护，记录插件身份、兼容范围、依赖和前后端选择。安装依赖后，`package.json` 提供构建、开发监听和打包命令：

```sh
npm run build
npm run dev
npm run package
```

`build` 将本次结果写入 `build/run-*`；`package` 会重新构建，并在 `release/` 生成 ZIP。打包工具根据 `plugin.json` 和实际产物生成 ZIP 根目录内的 `manifest.json`，其中 `files` 记录每个产物的路径、大小和 SHA-256；开发者不需要手写交付清单。同名 ZIP 不会被覆盖。`dev` 会监视插件源码，初次和每次保存后自动构建，不生成 ZIP。成功版本写入 `build/dev/<revision>/`，然后原子更新 `build/dev/current.json`；失败时保留上一版并在终端显示原因。`build/dev/status.json` 会显示构建、就绪、失败或停止状态，错误文本不超过 8192 个字符。终端运行期间按 Ctrl+C 停止监听。首版限制 ZIP 最大 256 MiB、解压后最大 512 MiB、清单最大 256 KiB，文件和目录总数最多 4096。

从早期脚手架项目升级时，在项目目录先备份构建脚本，再更新开发命令并复制仓库中新版模板：

```sh
cp scripts/build.mjs scripts/build.mjs.bak
npm pkg set "scripts.dev=node scripts/build.mjs dev"
cp "/path/to/Lodestory/packages/create-plugin/templates/project/build.mjs" scripts/build.mjs
```

这只替换构建工具脚本并添加开发命令，会保留 `plugin.json`、前后端源码和依赖。

前端使用 React，按公开 SDK 契约登记工作台内容，React 和 `@lodestory/sdk` 保留为外部依赖，由宿主提供同一实例。前端源码位于 `frontend/src`；可把静态文件放在 `frontend/assets`，引用的样式和图片等资源也会一起打包。生成的样式文件会记录在交付清单的 `frontend.styles` 中。

后端源码位于 `backend`。打包时按当前 Rust 工具链的宿主目标编译，把真实文件路径、系统、处理器和 Rust 目标三元组写进清单；一个后端包对应一个目标。构建含后端项目需要 Rust 和 Cargo。目标识别覆盖 macOS、Windows 和 Linux 的 x64、arm64；目前桌面联调只在 macOS arm64 完成。

脚手架使用 Node.js 18 或更新版本。当前包格式为 `1.0`，宿主接口版本为 `0.1.0`；前端示例依赖的布局能力为 `lodestory/layout@0`，当前版本为 `0.1.0`。宿主接口、React 和依赖的版本范围暂支持完整版本号（如 `0.1.0`）或 `^` 加完整版本号（如 `^0.1.0`），宿主和打包工具按同一规则校验。仅后端项目可直接运行 `npm install`。`@lodestory/sdk` 尚未发布到 npm：在发布前，含前端项目需要先本地打包 SDK，并在生成项目中安装该 SDK 包及其他构建依赖。

例如，在 Lodestory 仓库内执行 `npm pack ./packages/sdk --pack-destination /SDK包目录`，再在生成的插件项目内执行 `npm install --save-dev /SDK包目录/lodestory-sdk-0.1.0.tgz`。本地安装会更新该项目的 SDK 依赖路径；SDK 正式发布后可改回版本号。

在桌面版“设置 → 插件”选择 ZIP 后，应用会检查并启用插件；之前导入的包可点“加载”。已启用的包会在下次启动时恢复。包含前后端时，工厂收到的 `options.backend.call(...)` 使用相同的请求格式调用两种后端；生成的前端面板提供 `ping` 示例。

目前外部插件可声明 `lodestory/layout@0` 或 `lodestory/navigation-layout@0` 作为所需能力。插件依赖、对外提供能力和安装包更新尚未接入。前端入口必须默认导出返回 `Plugin` 的工厂，并且代码中的能力声明须与清单一致。当前桌面联调在 macOS arm64 完成，Windows 和 Linux 尚未验证。
