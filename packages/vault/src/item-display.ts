/**
 * 条目在列表里怎么显示 —— 图标用哪个、第二行写什么。
 *
 * ## 为什么这些在领域层而不是 UI 里
 *
 * 桌面端和浏览器插件都要显示条目列表，两边的 UI 各写一份的话，
 * 迟早会出现「同一个条目在插件里显示 bilibili、在桌面端显示 www.bilibili.com」。
 * 这些推导是纯函数、没有 DOM、没有网络，放在这里两边共用。
 *
 * ## 图标分两层
 *
 * 1. **站点图标**（`iconDomainOf`）—— 从服务端的图标接口取，真实站点的
 *    图标，这才是「一眼认出来」的来源。
 * 2. **彩色字母徽标**（`avatarOf`）—— 拿不到站点图标时的兜底。
 *    它不依赖任何网络，永远不会失败，所以**永远是可用的那一层**。
 *
 * ⚠️ 第二层不是「降级方案」那种将就：1Password 里「基金从业-Amac」显示的
 * 就是一个金色的「基金」，因为那个域名本来就没有 favicon。没有第二层的话，
 * 这些条目会显示成服务端返回的那张**灰色地球占位图** —— 一列灰块，
 * 比统一的钥匙图标还难看。
 */
import type { IdentityFields, VaultItem } from './model';
import { displayDomainOf } from './url-match';

/**
 * 这条条目该用哪个站点的图标。
 *
 * 先看条目自己存的网址，再退回**条目名**：导入进来的条目经常没有网址、
 * 名字本身就是个域名（Bitwarden 的 CSV 导出就是直接把
 * 「www.bilibili.com」当标题），而这一类恰恰最需要图标。
 */
export function iconDomainOf(item: VaultItem): string | null {
  for (const u of item.login?.uris ?? []) {
    const domain = displayDomainOf(u.uri);
    if (domain !== null) return domain;
  }
  return displayDomainOf(item.name);
}

/**
 * 列表行的第二行。
 *
 * 规则照着 1Password 的列表来：登录显示用户名、卡片显示掩码号、
 * 身份显示证件号。**没有可显示的东西时返回 null** —— 空着比填一句
 * 「登录信息」好，后者每一行都一样，等于没写。
 */
export function summaryOf(item: VaultItem): string | null {
  // 名字都解不开的条目在列表里显示「无法解密」，再透出用户名之类的内容
  // 只会让人以为这条是好的
  if (item.nameFailed) return null;

  switch (item.type) {
    case 'login': {
      const username = item.login?.username?.trim();
      if (username) return username;
      // 退回**域名**而不是整条 URL：URL 可能很长，会把上面的名字挤没
      for (const u of item.login?.uris ?? []) {
        const domain = displayDomainOf(u.uri);
        if (domain !== null) return domain;
      }
      return null;
    }

    case 'card': {
      const number = item.card?.number?.trim() ?? '';
      // ⚠️ 掩码。列表是用户截图、投屏、给别人看的地方，完整卡号摊在
      // 那里是实打实的泄露 —— 而这是**唯一**需要掩码的字段
      if (number.length > 8) return `${number.slice(0, 4)} **** ${number.slice(-4)}`;
      // 8 位以下首4尾4就把整串显示完了，掩了个寂寞，不如原样
      if (number.length > 0) return number;
      return item.card?.cardholderName?.trim() || null;
    }

    case 'identity': {
      const id = item.identity;
      return id?.ssn?.trim()
        || id?.passportNumber?.trim()
        || id?.licenseNumber?.trim()
        || identityName(id);
    }

    default:
      // 笔记、SSH 密钥、以及服务端有新类型而我们还没建模的那些
      return null;
  }
}

function identityName(id: IdentityFields | null): string | null {
  if (id === null) return null;
  const name = [id.firstName, id.middleName, id.lastName]
    .map((p) => p?.trim() ?? '')
    .filter((p) => p.length > 0)
    .join(' ');
  return name.length > 0 ? name : null;
}

/** 字母或数字（任意文字系统）—— 用来跳过「—」「·」「@」这类开头 */
const WORD = /[\p{L}\p{N}]/u;

/** 名字里什么都没有时的占位。总要显示点什么，空框看起来像加载失败 */
const NO_INITIALS = '?';

/**
 * 从条目名里取徽标文字 —— 前两个字母或数字，中日韩与拉丁同一条规则。
 */
function initialsOf(name: string): string {
  // ⚠️ 按**码点**切分（`[...name]`），不能用 `name[i]` —— emoji 和增补平面
  // 的汉字是代理对，按 UTF-16 码元切会切出半个字符，渲染成方块。
  //
  // 只留字母和数字：开头那些「—」「·」「@」会被自然跳过，而且
  // **中日韩和拉丁走同一条规则** —— `\p{L}` 本来就覆盖汉字，
  // 单开一支 CJK 分支是白写的，还多一类编码 bug。
  const chars = [...name].filter((c) => WORD.test(c));
  return chars.length > 0 ? chars.slice(0, 2).join('') : NO_INITIALS;
}

/**
 * 由键算出颜色（0–359）。
 *
 * ⚠️ **必须是确定性的**，不能用随机数。随机会让同一批条目在每次渲染时
 * 换一次颜色（滚动、重新同步、切分类都会重渲），画面看起来在抖。
 * 用户对「紫色那个 ZI 是 Zlib」是有肌肉记忆的，颜色变了就得重新找。
 *
 * 用的是 FNV-1a：够散，够短，而且跨语言实现一致 —— 插件（浏览器）和
 * 桌面端（WebView）都得算出同一个颜色。
 */
function hueOf(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/**
 * 拿不到站点图标时显示的彩色字母徽标。
 *
 * 只返回色相，不返回完整颜色 —— 明度和彩度要跟着亮/暗主题走，
 * 那是 CSS 的事，领域层不该知道当前是什么主题。
 */
export function avatarOf(item: VaultItem): { text: string; hue: number } {
  // 有站点的按**域名**取色：同一个站点的多条登录应该是同一个颜色，
  // 否则「工作账号」和「私人账号」两个 GitHub 条目会一个绿一个紫
  const key = iconDomainOf(item) ?? item.name;
  return { text: initialsOf(item.name), hue: hueOf(key) };
}
