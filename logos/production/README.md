# 1Warden 生产图标

本版以用户提供的 [原始设计](../1warden-retro-navy-brass-v6.png) 为依据，保留深蓝、象牙白、黄铜阴影与像素盾牌中的「1」。原始 PNG 保持不变。

**最终产物来自 SVG 精修和本地脚本导出，不是图像生成工具的输出。** 背景中的透明区域是真实 alpha；预览页的棋盘格仅用于展示透明效果，不写入图片。

内置图像工具的两次未采用尝试及提示词见 [制作记录](generation-notes.md)；没有使用 CLI 图像生成服务。

直接打开 [preview.html](preview.html)，可在浅色、深色和透明背景下查看原尺寸小图。

## 三个光学校正版

| 源文件 | 使用位置 | 调整 |
| --- | --- | --- |
| [app.svg](app.svg) | 大尺寸应用图标、关于页 | 64 单位像素网格；保留细边与黄铜立体感，去掉纸张纹理和不规则高光。 |
| [compact.svg](compact.svg) | 16–48 px 工具栏、扩展、Windows 托盘；小尺寸应用内标识 | 16 单位像素网格；加粗盾牌与数字，移除阴影，避免缩小时糊成一块。 |
| [tray-template.svg](tray-template.svg) | macOS 菜单栏模板 | 仅黑色轮廓与真实透明，交给系统根据明暗外观着色。 |

数字「1」与盾牌之间保留间隔。小图不是将大图机械缩小：它们专门为低像素密度调整了笔画与留白。

## 复现

在项目根目录执行：

```sh
bun run build:icons
bun run test scripts/icon-assets.test.ts
```

导出脚本使用项目已有的 Tauri 图标转换器，无额外图像依赖。源文件变更后需重新导出，并重编译应用或扩展；浏览器和 Windows Shell 可能仍缓存已安装版本的旧图标。

主要输出：

- `apps/desktop/src-tauri/icons/icon.ico`：16、24、32、48、64、128、256 px。
- 同目录 `icon.icns`：标准与 Retina PNG 条目，最高 1024 px；`icon.png`：512 px。
- 同目录 `tray-color.png` 和 `tray-template.png`：32 px 彩色/模板托盘图。
- `apps/desktop/extension/public/icons/`：16、24、32、48、64、128 px。
- `apps/desktop/public/brand/` 与 `packages/ui/src/brand/`：共用网页和 React 标识。
- iOS `AppIcon.appiconset`：按现有资产目录的点尺寸与倍率逐项生成；**使用不透明深蓝底，不带 alpha 通道**。

## 验证范围

`scripts/icon-assets.test.ts` 解码 PNG 像素，验证四角真实透明、16–48 px 数字与盾牌不连接、ICO 分辨率目录、ICNS 容器、共享图标一致性，以及全部 iOS 尺寸和不透明背景。预览页用于人工核对实际显示尺寸的可读性。

这些检查验证图标文件本身；macOS 和 iOS 的原生安装显示效果仍需在对应系统中验收。
