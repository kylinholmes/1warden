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
 * `offscreen`：Firefox 系**没有**这个 API，而扩展用它做「剪贴板 30 秒后
 * 自动清理」。运行时代码里已经**降级**了 —— 复制照常，只是不安排自动清理。
 *
 * 真正的解（`alarms` 或「下次唤醒时清理」）还没做，那要改行为、得单独决定。
 * 所以产物**可用但不完整**。
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

/*
 * ③ `offscreen` 权限 —— Firefox **不认识这个名字**。
 *
 * 实测（Zen 载入时的 manifest 警告）：
 *
 *     Warning processing permissions: Error processing permissions.3:
 *     Value "offscreen" must either: ... [一长串合法值]
 *
 * 它报的是 Warning 不是 Error，所以扩展还是能装进去、只是这个权限被丢掉 ——
 * 于是运行时的降级判断（`!ext.offscreen`）正好接住。
 *
 * ⚠️ **必须删掉**：留着它，每次载入都会弹一条警告，而警告刷多了
 * 真问题就被淹了。而删掉之后行为和「装了但被丢掉」完全一样，没有损失。
 */
const perms = (m['permissions'] as string[] | undefined) ?? [];
const kept = perms.filter((p) => p !== 'offscreen');
if (kept.length !== perms.length) m['permissions'] = kept;

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
console.log('   ⚠️ 复制可用，但**不会自动清空剪贴板**（Firefox 没有 offscreen API，');
console.log('      所以「30 秒后清理」那个定时器没有地方活）。');
console.log('   装入方式：Zen/Firefox 的 about:debugging → 临时载入 → 选 dist-firefox/manifest.json');
