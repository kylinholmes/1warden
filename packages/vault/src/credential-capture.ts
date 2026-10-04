/**
 * 提交后该不该提示保存 —— 1Password 最有存在感的行为，也是最容易做烦人的一个。
 *
 * 用户每天登录十几次。**每次都弹「要保存吗」比不弹还糟**：他会条件反射地点掉，
 * 真有新密码时也一并点掉。所以这里的默认答案是「不出声」，只有确实有信息
 * 增量时才打扰。
 *
 * ⚠️ 返回值里**绝不含密码本身**。它会被送进界面、可能被序列化。要写入时，
 * 明文由 background 现取现用。
 */
import { matchItemsByUrl } from './url-match';
import type { VaultItem } from './model';

export type CaptureDecision =
  | { kind: 'save' }
  | { kind: 'update'; itemId: string }
  | { kind: 'none'; reason: 'noPassword' | 'placeholder' | 'noSite' | 'unchanged' };

export interface CapturedLogin {
  url: string;
  username: string | null;
  password: string;
}

/**
 * 页面脚本常常把密码框填成掩码或占位符 —— 那不是用户输入的密码。
 *
 * 判据：整串由同一个字符组成，且是 `*` 或 `•`。真实的密码极少长这样，
 * 而掩码一定长这样。
 */
function looksLikeMask(value: string): boolean {
  return /^([*•·])\1*$/.test(value);
}

/**
 * 决定这条捕获到的凭据该怎么处理。
 *
 * @param captured 提交时从页面上读到的值
 * @param items    当前保险库里的全部条目
 */
export function decideCapture(
  captured: CapturedLogin,
  items: readonly VaultItem[],
): CaptureDecision {
  const password = captured.password;

  // 空密码：表单可能只是被清空了，或者这是个非登录表单
  if (password.trim().length === 0) return { kind: 'none', reason: 'noPassword' };
  if (looksLikeMask(password)) return { kind: 'none', reason: 'placeholder' };

  // 匹配规则复用自动填充那一套 —— 两处判断必须一致，
  // 否则会出现「填的时候认得、存的时候不认得」这种自相矛盾的行为
  const matching = matchItemsByUrl(items, captured.url);
  if (matching.length === 0) {
    // 网址解析不了（about:blank、扩展页面）时 matchItemsByUrl 会返回空，
    // 但那时保存也没有意义 —— 存下来以后永远匹配不上
    return isWebUrl(captured.url) ? { kind: 'save' } : { kind: 'none', reason: 'noSite' };
  }

  // 挑出该改哪一条。顺序即优先级，每一步都在**收紧猜测的程度**：
  //
  //   1. 用户名一模一样 —— 确定是同一条
  //   2. 站内某条没记用户名 —— 不知道是谁，多半就是它
  //   3. 表单压根没给用户名，且站内只有一条 —— 只能是它
  //
  // 剩下的情况一律存成新条目。**绝不**「反正只有一条就改它」——
  // 那条可能是同事的账号，改掉等于毁了他的记录。
  const target =
    (captured.username === null
      ? undefined
      : matching.find((i) => i.login?.username === captured.username))
    ?? matching.find((i) => i.login?.username === null)
    ?? (captured.username === null && matching.length === 1 ? matching[0] : undefined);

  if (!target) {
    // 站点的记录都是别的账号 —— 这是一个新账号，存成新条目
    return { kind: 'save' };
  }

  const stored = target.login?.password ?? null;
  if (stored === password) return { kind: 'none', reason: 'unchanged' };

  // 存的是 null（从没记过密码）也算「有变化」，该补上
  return { kind: 'update', itemId: target.id };
}

function isWebUrl(url: string): boolean {
  try {
    const proto = new URL(url).protocol;
    return proto === 'http:' || proto === 'https:';
  } catch {
    return false;
  }
}
