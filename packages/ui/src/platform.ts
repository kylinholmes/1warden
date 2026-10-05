/**
 * 这个构建是给**哪个平台**的 —— 编译期常量。
 *
 * ## 为什么需要它
 *
 * 两端的界面里有一部分差异**不是宽度造成的，是能力造成的**：
 *
 * - 桌面端有文件夹、安全报告、导入、自动输入
 * - 浏览器扩展没有（它跑在别人的页面旁边，只有「填充」「复制」「保存」）
 * - 移动端将来又是另一套
 *
 * 这类差异**不该靠运行时探测**（`'tabs' in chrome` 那种）：探测出来的是
 * 「当前环境像什么」，而这里要回答的是「这个构建是给谁的」。
 * 前者会在测试环境、预览页、未来的新宿主上给出错误的答案，而且错得没有规律。
 *
 * ## 编译期，不是运行期
 *
 * 各 app 的 vite 配置里写：
 *
 *     define: { __PLATFORM__: JSON.stringify('desktop') }
 *
 * 打包时 `__PLATFORM__` 被**文本替换**成字面量，于是
 * `PLATFORM === 'extension'` 这种判断会被折叠掉，另一端的分支直接不进产物 ——
 * 而不是「打进去了但不会执行」。对扩展尤其要紧：它的包越小越好，
 * 而且不该带着桌面端才有的代码。
 *
 * ## ⚠️ 未定义时降级成 `'unknown'`，不抛错
 *
 * 测试（vitest）、临时脚本、将来别的宿主都可能在没有这个 define 的环境里
 * 碰到这个模块。那里**不该崩** —— 崩了的话，一个查看某个组件的单测会因为
 * 「这个构建是给谁的」这种和它无关的问题挂掉。
 *
 * `typeof 未声明的标识符` 在 JS 里是安全的（不抛 ReferenceError），
 * 所以这个降级本身也是编译期可折叠的。
 */
declare const __PLATFORM__: 'desktop' | 'extension' | 'mobile' | undefined;

export type Platform = 'desktop' | 'extension' | 'mobile' | 'unknown';

export const PLATFORM: Platform =
  typeof __PLATFORM__ === 'string' ? __PLATFORM__ : 'unknown';

/** 有没有**本机**能力：原生对话框、附件存盘、自动输入、文件夹、导入导出 */
export const IS_DESKTOP = PLATFORM === 'desktop';

/** 跑在别人的页面旁边：只有填充/复制/保存，没有文件系统也没有原生壳 */
export const IS_EXTENSION = PLATFORM === 'extension';

export const IS_MOBILE = PLATFORM === 'mobile';
