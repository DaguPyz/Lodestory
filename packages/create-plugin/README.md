# Lodestory 后端项目脚手架

此包用于创建最小 Rust 后端项目：`process` 生成独立程序，`dynamic-library` 生成动态库。生成的项目实现现有 A 或 B 的通信和退出约定，并提供一个 `ping` 示例。

包名和发布方式以实际发布结果为准。发布后，计划使用：

```sh
npx @lodestory/create-plugin
```

运行后选择独立程序 C 或动态库 D，再输入项目名。也可以通过参数直接指定：

```sh
npx @lodestory/create-plugin --type process --name my-c
npx @lodestory/create-plugin --type dynamic-library --name my-d
```

发布前，可在 Lodestory 仓库根目录运行本地入口：

```sh
node packages/create-plugin/bin/create-plugin.mjs
```

默认在当前目录中创建与名称相同的目录；可用 `--output` 指定其他目标路径。目标路径必须不存在，其父目录必须已存在；已有文件或目录不会被覆盖。名称须以小写英文字母开头，最多 64 个字符，只包含小写字母、数字、连字符或下划线，且不能使用 Rust 或 Cargo 的保留名称。

运行脚手架需要 Node.js 18 或更新版本；编译生成的项目需要 Rust 和 Cargo。项目依赖 `serde_json`，首次编译可能需要下载依赖。

生成结果是后端项目，不是可直接安装的完整插件包。当前需要通过接入应用的代码指定编译产物的绝对路径，调用 A 或 B；外部插件包安装和前端加载尚未实现。
