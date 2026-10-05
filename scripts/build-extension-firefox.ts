#!/usr/bin/env bun
/**
 * 把扩展的构建产物转成 Firefox 系（Firefox / Zen）能装的形态。
 *
 *   bun run scripts/build-extension-firefox.ts
 *
 * 产物 `apps/extension/dist-firefox/` —— **不覆盖** `dist/`，
 * 所以 Chrome 那条路一点没变。
 *
 * ## 为什么是「先构建、再改写」而不是两套源码
 *
 * 两边 99% 相同，差异全在 manifest 的一个小角落。分两套源码的话，
 * 每加一个功能都要记得改两处 —— 而那正是这个项目里已经吃过几次亏的模式
 * （令牌拷贝、图标拷贝，两次都长歪了）。
 *
 * 这里只改写**差异的那几行**，其余原样搬。差异写在一处，看得见。
 *
 * ## ⚠️ 这个脚本**还没有解决**的事
 *
 * `offscreen` 权限：Firefox 系**没有** offscreen API，而扩展用它做
 * 「剪贴板 30 秒后自动清理」（定时器要有地方活）。这一版**保留**了那个
 * 权限声明 —— 目的是先让它**能装进去**，看真正坏在哪，再决定怎么替。
 *
 * 所以产物是**可加载但不完整**的。别把它当成可用版本发出去。
 */
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'apps/extension/dist');
const OUT = join(ROOT, 'apps/extension/dist-firefox');

if (!existsSync(SRC)) {
  console.error(`❌ 找不到 ${SRC} —— 先跑一次 apps/extension 的 build`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });

const manifestPath = join(OUT, 'manifest.json');
const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

// ① service worker → 事件页。Firefox MV3 **没有** service worker，
//    但两者的生命周期假设一样（都会被卸载），所以运行时代码不用改
const bg = m['background'] as { service_worker?: string; type?: string };
m['background'] = { scripts: [bg.service_worker ?? 'background.js'], type: bg.type ?? 'module' };

// ② Chrome 专有的版本下限，Firefox 会当成未知键
delete m['minimum_chrome_version'];

// ③ Firefox 需要的身份与版本下限。
//    `strict_min_version` 取 **128**：`world: "MAIN"` 内容脚本从那一版才有，
//    而 WebAuthn 注入正是靠它（本机 Zen 实测 Gecko 156，够）
m['browser_specific_settings'] = {
  gecko: {
    id: 'coffer@coffer.app',
    strict_min_version: '128.0',
  },
};

writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
console.log('✅ 已产出 Firefox 版：apps/extension/dist-firefox');
console.log('   ⚠️ 仍带着 offscreen 权限 —— 可加载，但剪贴板清理那部分跑不通。');
console.log('   装入方式：Zen/Firefox 的 about:debugging → 临时载入 → 选 dist-firefox/manifest.json');
