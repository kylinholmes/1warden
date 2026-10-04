import { describe, it, expect } from 'vitest';
import { webAssemblyAvailable } from './capabilities';

describe('webAssemblyAvailable', () => {
  it('is true where WebAssembly actually works', () => {
    expect(webAssemblyAvailable()).toBe(true);
  });

  /**
   * 真正的失败模式是「编译被 CSP 拦下」，不是「WebAssembly 对象不存在」。
   * 这条测试用打桩模拟前者 —— 确保检查走的是真的编译，而不是只看看 typeof。
   */
  it('is false when module compilation is blocked', () => {
    const real = WebAssembly.Module;
    // @ts-expect-error —— 故意把构造器换成会抛的版本
    WebAssembly.Module = function Blocked() {
      throw new TypeError('Refused to create a WebAssembly object because ... CSP ...');
    };
    try {
      expect(webAssemblyAvailable()).toBe(false);
    } finally {
      WebAssembly.Module = real;
    }
  });
});
