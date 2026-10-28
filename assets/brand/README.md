# Lodestory 标识

`lodestory-mark.svg` 是透明背景的彩色标识，可用于文档和其他品牌素材。
其几何形状由 `packages/ui/src/brandLogoGeometry.mjs` 定义，应用界面复用同一形状，笔尖颜色随界面前景色变化以适配明暗主题。

修改几何形状后，在仓库根目录运行 `pnpm run generate:icons`，更新此 SVG 和桌面应用图标。
