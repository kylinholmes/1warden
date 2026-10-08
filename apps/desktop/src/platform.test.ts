import { describe, expect, it } from 'vitest';
import { detectOs, primaryShortcut, quickShortcut } from './platform';

/**
 * ⚠️ 这一组测试守的是一个**只在真机上才看得见**的 bug。
 *
 * `detectOs` 原本先判 `Mac OS X`，而 **iPhone 的 UA 里就含有
 * "like Mac OS X"**：
 *
 *     Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)
 *     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1
 *                        ^^^^^^^^^^^^^^^^ 就是这四个字
 *
 * 于是 iOS 被判成 mac，`--titlebar-h` 拿到 28px —— 那是给**三个红绿灯圆点**
 * 留的高度。iPhone 上没有那三个点，结果是顶部白白空掉 28px。
 *
 * 为什么这值得一组专门的测试：这个 bug 在**开发机上永远不复现**
 * （桌面浏览器的 UA 没有 "like Mac OS X"），而类型检查、全部单测、
 * 构建也全都不会报错 —— 它只在真机上以「界面顶上多一条空白」的样子出现，
 * 而那个样子很容易被当成「设计如此」。
 *
 * 所以把 UA 变成**参数**：这是让这个判断能被测试的唯一办法，
 * 而它本来就是个纯函数，读全局的 `navigator` 只是让它白白不可测。
 */
// 真实 UA（照抄自各平台，不是编的）
const UA = {
  macOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iPad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
} as const;

describe('detectOs', () => {
  it('iPhone 不是 mac —— UA 里的「like Mac OS X」不该被当成 macOS', () => {
    expect(detectOs(UA.iPhone)).toBe('ios');
    expect(detectOs(UA.iPad)).toBe('ios');
  });

  it('真正的 macOS 还是 mac', () => {
    expect(detectOs(UA.macOS)).toBe('mac');
  });

  it('Windows 还是 win', () => {
    expect(detectOs(UA.windows)).toBe('win');
  });

  it('Android 不该被当成别的什么', () => {
    expect(detectOs(UA.android)).toBe('android');
  });

  it('认不出来就给 other，不抛错也不猜', () => {
    expect(detectOs('')).toBe('other');
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('other');
  });
});

describe('platform shortcuts', () => {
  it('uses Ctrl for Windows and Command for macOS', () => {
    expect(primaryShortcut('N', 'win')).toBe('Ctrl+N');
    expect(primaryShortcut('N', 'mac')).toBe('⌘N');
    expect(primaryShortcut('N', 'ios')).toBe('⌘N');
  });
  it('matches each native quick-access registration', () => {
    expect(quickShortcut('win')).toBe('Ctrl+Shift+\\');
    expect(quickShortcut('mac')).toBe('⌘⇧\\');
  });
});
