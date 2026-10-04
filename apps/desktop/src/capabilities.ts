/**
 * 启动时的能力自检。
 *
 * 密钥派生（Argon2id / PBKDF2）跑在 WebAssembly 里。WASM 用不了的话，
 * 这个应用**完全没有价值** —— 它连主密码都处理不了。但失败会发生在用户
 * 填完表单点「解锁」之后，而且报出来的是浏览器那句英文 CSP 提示：
 *
 *   Refused to create a WebAssembly object because 'unsafe-eval' or
 *   'wasm-unsafe-eval' is not an allowed source of script...
 *
 * 这对用户毫无意义。所以启动时先真的编一个最小模块试一下 ——
 * 不行就当场说清楚，别让人白填一遍表单。
 */

/** 最小的合法 WASM 模块：魔数 `\0asm` + 版本 1，没有任何内容 */
const MINIMAL_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/**
 * 能不能真的编译 WASM。
 *
 * ⚠️ 光判断 `typeof WebAssembly !== 'undefined'` 不够：对象在，但编译会被
 * CSP 拦下 —— 那正是本应用真实踩过的坑。必须实际编一次。
 */
export function webAssemblyAvailable(): boolean {
  try {
    if (typeof WebAssembly === 'undefined') return false;
    new WebAssembly.Module(MINIMAL_MODULE);
    return true;
  } catch {
    return false;
  }
}

/** 跑在 Tauri 壳里才有 Rust 侧可以调；纯浏览器里没有 */
export function tauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
