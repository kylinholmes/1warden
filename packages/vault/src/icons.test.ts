import { describe, it, expect } from 'vitest';
import {
  iconUrlFor, isPlaceholderIcon, IconStore,
  PLACEHOLDER_ICON_SHA256, PLACEHOLDER_ICON_BYTES,
} from './icons';

/**
 * 站点图标走 Vaultwarden 的 `/icons/{域名}/icon.png`。
 *
 * ## 这个接口有一个陷阱
 *
 * **没有图标时它不回 404，而是回 HTTP 200 + 一张灰色的地球占位图。**
 * 也就是说状态码判断不了「到底有没有图标」——照单全收的话，
 * 每个没有 favicon 的域名都显示成同一坨灰块，比统一的钥匙图标还难看。
 *
 * 实测：三个不存在的域名返回的字节**完全一致**，所以按字节指纹能可靠认出来。
 * 下面那张 483 字节的图就是**服务端真实返回的**，不是造出来的 ——
 * 造一张哈希对得上的图不可能，用长度代替又等于没测。
 */
const PLACEHOLDER_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABMAAAATCAQAAADYWf5HAAABqklEQVR42nWSA6wcYRSFb22bUaM2KIPatm1bc7/7XDtWbdu2bdsOa/fP7Dy//XbHJ+dSEqE0xgle84NX7mpRpSQlE7LqHL5zgvHawCpZJz5znW86a0JWSWR8Yc5yO6KaBNCTQSJeLe5yZnzhBCcn+klNcYzJH1lEJKIARzSXiObisJ4ekcWXuXAPrD5bNEL3sI5l7LdtnCKPiC+8y8xQ4t9xTlaBJhOyB/4ZO2SQAK3HN1cMxgUJQ4cMuto5fzSEEyx2eQRYGUYxYEL6wClO+4nYOI4Jr20pR8YVdOln03m2XNvbGI0TB+V0rTisPq+EH1bFqrDVGrOfRn5m2W1bqC022PeszA/hlbYW8WowPqpEEKqXC+XLWWfTRLQB74UTqCSD2RFlE3LdMSF9KDfjsiTD+tNdAtjoxnhSYySqFN+8WpIEzeVyC0AxfmpJEdFZPJ6QWxyM1T3sZh+dE2Rd+cfsYKacsaOWz2uusyQZo/Ny2I6PyZawIXqae1wnT7Ic63OXs8nejcjCTL5x1jyaWRWvueFvzcSBmSQlUaUMjvGK7/aUI4x1m5bAf44zwZcVEKqvAAAAAElFTkSuQmCC';

function placeholderBytes(): Uint8Array {
  const bin = atob(PLACEHOLDER_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

describe('iconUrlFor', () => {
  it('拼出服务端图标的地址', () => {
    expect(iconUrlFor('https://vault.test', 'github.com'))
      .toBe('https://vault.test/icons/github.com/icon.png');
  });

  /** 服务端地址末尾带斜杠是常态，不能拼出 `//icons` */
  it('容忍服务端地址末尾的斜杠', () => {
    expect(iconUrlFor('https://vault.test/', 'github.com'))
      .toBe('https://vault.test/icons/github.com/icon.png');
    expect(iconUrlFor('https://vault.test///', 'github.com'))
      .toBe('https://vault.test/icons/github.com/icon.png');
  });

  /** 域名是路径的一段，不是可以随便拼的字符串 */
  it('转义域名里的特殊字符', () => {
    expect(iconUrlFor('https://vault.test', 'a b/c')).toBe('https://vault.test/icons/a%20b%2Fc/icon.png');
  });
});

describe('isPlaceholderIcon', () => {
  /** 夹具本身要自洽：否则下面的判定测的是别的东西 */
  it('夹具就是那张占位图', async () => {
    const bytes = placeholderBytes();
    expect(bytes.length).toBe(PLACEHOLDER_ICON_BYTES);
    expect(await sha256Hex(bytes)).toBe(PLACEHOLDER_ICON_SHA256);
  });

  it('★ 认出服务端返回的占位图', async () => {
    expect(await isPlaceholderIcon(placeholderBytes())).toBe(true);
  });

  it('把真实图标判为不是占位图', async () => {
    // 真图标（一张 33KB 的 PNG）连摘要都不用算，长度就差得远
    expect(await isPlaceholderIcon(fakeBytes(33270))).toBe(false);
  });

  /**
   * ⚠️ 长度相同但内容不同时必须判为**真图标**。
   *
   * 只比长度的话，一张刚好 483 字节的真实 favicon 会被当成占位图丢掉，
   * 而用户看到的是字母徽标 —— 一个「看起来正常」的错误结果。
   */
  it('长度相同但内容不同时判为真图标', async () => {
    const bytes = placeholderBytes();
    bytes[100] = bytes[100]! ^ 0xff;   // 只改一个字节
    expect(await isPlaceholderIcon(bytes)).toBe(false);
  });

  it('空响应不算占位图', async () => {
    expect(await isPlaceholderIcon(new Uint8Array(0))).toBe(false);
  });
});

describe('IconStore', () => {
  it('取到真图标时返回可直接用的 data URL', async () => {
    const store = new IconStore({
      serverUrl: 'https://vault.test',
      fetchBytes: async () => fakeBytes(4096),
    });
    const url = await store.get('github.com');
    expect(url).toMatch(/^data:image\/png;base64,/);
    expect(atob(url!.slice('data:image/png;base64,'.length)).length).toBe(4096);
  });

  /**
   * ⚠️ 这个模块存在的理由：拿回占位图时必须返回 **null**，
   * 让调用方改用彩色字母徽标。
   *
   * 返回那张灰地球的后果是——每个没有 favicon 的域名（内网地址、
   * 生僻站点、导入数据里的域名）全都显示成同一坨灰块。
   */
  it('★ 拿回占位图时返回 null，而不是那张灰地球', async () => {
    const store = new IconStore({
      serverUrl: 'https://vault.test',
      fetchBytes: async () => placeholderBytes(),
    });
    expect(await store.get('nope.com')).toBeNull();
  });

  /**
   * ⚠️ 判别占位图要算 SHA-256，而那要求 `crypto.subtle`（只在安全上下文里有）。
   *
   * 万一它不可用，异常必须止在 `get` 里面。冒出去的后果不是「图标少一个」，
   * 而是**整个列表渲染不出来** —— 这个降级方向必须是安全的那个。
   */
  it('算不了摘要时也要降级成 null，而不是抛出去', async () => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    // 赋一个必抛的函数进去 —— 类型上合法（never 可赋给任何返回类型），
    // 但运行时就是我们想模拟的「算不了摘要」
    crypto.subtle.digest = () => { throw new Error('没有 crypto.subtle'); };
    try {
      const store = new IconStore({
        serverUrl: 'https://vault.test',
        // 长度正好是占位图那个长度 —— 会走到算摘要那一步
        fetchBytes: async () => new Uint8Array(PLACEHOLDER_ICON_BYTES),
      });
      await expect(store.get('x.com')).resolves.toBeNull();
    } finally {
      crypto.subtle.digest = original;
    }
  });

  it('请求失败时返回 null 而不是抛错', async () => {
    const store = new IconStore({
      serverUrl: 'https://vault.test',
      fetchBytes: async () => { throw new Error('网络炸了'); },
    });
    // 图标取不到不该让整个列表炸掉
    await expect(store.get('github.com')).resolves.toBeNull();
  });

  it('服务端返回空体时返回 null', async () => {
    const store = new IconStore({
      serverUrl: 'https://vault.test',
      fetchBytes: async () => new Uint8Array(0),
    });
    expect(await store.get('github.com')).toBeNull();
  });

  it('请求的是那个域名对应的地址', async () => {
    const seen: string[] = [];
    const store = new IconStore({
      serverUrl: 'https://vault.test',
      fetchBytes: async (url) => { seen.push(url); return fakeBytes(2048); },
    });
    await store.get('bilibili.com');
    expect(seen).toEqual(['https://vault.test/icons/bilibili.com/icon.png']);
  });

  /**
   * ⚠️ 同一个域名**只请求一次**。
   *
   * 列表每次渲染都会问一次图标，滚动、搜索、切分类都会重渲。
   * 不缓存的话同一个域名会被请求几十次，而服务端首次抓取要 1.5 秒。
   */
  it('同一域名只发一次请求', async () => {
    let calls = 0;
    const store = new IconStore({
      serverUrl: 'https://vault.test',
      fetchBytes: async () => { calls++; return fakeBytes(); },
    });
    await Promise.all([store.get('a.com'), store.get('a.com'), store.get('a.com')]);
    await store.get('a.com');
    expect(calls).toBe(1);
  });

  /** 并发问同一个域名也要只发一次 —— 列表首次渲染就是并发问的 */
  it('并发问同一域名也只发一次', async () => {
    let calls = 0;
    const store = new IconStore({
      serverUrl: 'https://vault.test',
      fetchBytes: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return fakeBytes();
      },
    });
    const [a, b] = await Promise.all([store.get('x.com'), store.get('x.com')]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  /** 失败也要缓存 —— 否则一个没有图标的域名会在每次重渲时重试 */
  it('缓存失败的结果，不反复重试', async () => {
    let calls = 0;
    const store = new IconStore({
      serverUrl: 'https://vault.test',
      fetchBytes: async () => { calls++; throw new Error('nope'); },
    });
    await store.get('bad.com');
    await store.get('bad.com');
    expect(calls).toBe(1);
  });
});

/** 造一段假图标的字节 —— 只用来区分长度与内容，不代表任何真实图片 */
function fakeBytes(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `slice()` 拿到的是自己的 ArrayBuffer —— 绕开 Uint8Array<ArrayBufferLike>
  // 与 BufferSource 之间的类型纠缠（实现那边同理）
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
