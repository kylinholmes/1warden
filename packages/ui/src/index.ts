/**
 * 共享的界面层 —— 桌面端与扩展端共用。
 *
 * 目前四样：
 *   · `./theme.css`     设计令牌（CSS，走 `@coffer/ui/theme.css` 引）
 *   · `./components.css` 块级组件的样式（图标方块等）
 *   · `./icons`         图标集
 *   · `./ItemIcon`      条目图标（站点图标 → 彩色徽标 → 类型图标）
 *   · `./ItemRow`       列表里的一行
 *   · `./clipboard`     剪贴板约定（常量 + 纯函数，**无 React**，离屏文档也用）
 *   · `./CopyButton`    复制按钮（界面与反馈）
 *   · `./SecretField`   可复制/可揭示的字段 + 详情分组 `Section`
 *   · `./platform`      编译期平台常量（`__PLATFORM__`，见那个文件顶部）
 *   · `./host`          **运行时**宿主接口（发请求 / 落盘存储）—— 唯一的两处真差异
 *   · `./icon-disk`     图标落盘缓存（IndexedDB）—— 和平台无关，两端共用
 *   · `./NavRail`       导航栏（折叠 80 / 展开 214，两端共用）
 *
 * 每一样都是**先发现了两份拷贝**才搬过来的：令牌那份扩展端已经落后一版，
 * 图标那份扩展端自己写着「和桌面端是同一套画法」—— 同一套画法写两遍，
 * 迟早不是同一套。
 *
 * ⚠️ 引这个包里的组件时，**CSS 也得引**（`@coffer/ui/components.css`）。
 * 漏引的后果是「类名在 DOM 上、规则不在产物里」—— 构建、类型检查、
 * 单测全都不会报，只有肉眼看得见。有守卫测试盯着这件事
 * （`apps/extension/src/shared-css-wiring.test.ts`）。
 *
 * 还没有搬过来的：**详情块的外壳**（`ItemDetail`）。
 *
 * 详情块的**零件已经有了**（`SecretField` / `Section` / `CopyButton`），
 * 剩下的外壳拖着 `VaultClient`（附件下载）、Tauri 对话框、原生自动输入
 * 几个 app 级依赖，得先把它们降级成插槽才搬得动。
 */
export * from './icons';
export * from './ItemIcon';
export * from './ItemRow';
export * from './clipboard';
export * from './CopyButton';
export * from './SecretField';
export * from './destinations';
export * from './platform';
export * from './host';
export * from './icon-disk';
export * from './icon-store';
export * from './sync-cache';
export * from './strength';
export * from './NavRail';
