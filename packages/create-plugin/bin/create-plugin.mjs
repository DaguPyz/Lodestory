#!/usr/bin/env node

import {createProject, parseArgs, promptOptions, usage} from "../lib/create-project.mjs";

try {
  const args = process.argv.slice(2);
  const options = args.length ? parseArgs(args) : await promptOptions(process.stdin, process.stdout);
  if (options.help) {
    console.log(usage);
  } else {
    const destination = await createProject(options);
    console.log("已创建插件项目：" + destination);
    console.log("进入项目目录后安装依赖，再运行 npm run dev、npm run build 或 npm run package。");
    if (!options.id || options.id.startsWith("com.example.")) {
      console.log("当前插件 ID 是示例，请在交付前更新 plugin.json。");
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("使用 --help 查看用法。");
  process.exitCode = 1;
}
