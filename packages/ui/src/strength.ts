/**
 * 强度怎么说 —— 说法和颜色只在这一处定义。
 *
 * 编辑器里的即时强度条和生成器的结论都要说「这有多强」，
 * 两处各写一份词表的话，迟早会出现「一般」和「中等」并存，
 * 或者同一个分数在一处是绿色、在另一处是橙色。
 *
 * ⚠️ 分档本身**不在这里** —— 它由 `@1warden/crypto` 的 `passwordStrength`
 * 定（28 / 50 / 70 / 100 位熵），这里只负责把那个 score 翻译成人话。
 * 分档写两份才是真的会出事：同一个密码在两个界面上被评成两档。
 */

/** 五档的说法，索引就是 `passwordStrength` 的 score */
export const STRENGTH_LABELS: readonly string[] = ['很弱', '弱', '一般', '强', '很强'];

/** 五档的颜色。只有三档颜色 —— 「很弱」和「弱」不需要两种红 */
export const STRENGTH_COLORS: readonly string[] = [
  'var(--risk)', 'var(--risk)', 'var(--caution)', 'var(--safe)', 'var(--safe)',
];

/*
 * 每秒能试多少次 —— 一个**讲得清楚**的假想机器，而不是任何真实设备。
 *
 * 取一万亿（10^12）：这是拿高端 GPU 集群去跑快速哈希的量级，
 * 比用户手里任何一台机器都快得多。宁可把攻击者想得强一点：
 * 强度提示说低了，用户会去改；说高了，他就不改了。
 */
const GUESSES_PER_SECOND = 1e12;

/** 平均要试掉一半的空间 —— 2^(bits-1) 次 */
function secondsToCrack(entropyBits: number): number {
  return 2 ** (entropyBits - 1) / GUESSES_PER_SECOND;
}

const UNIVERSE_AGE_YEARS = 1.38e10;

function zhNumber(n: number): string {
  const trim = (v: number): string => String(v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
  if (n >= 1e8) return `${trim(n / 1e8)} 亿`;
  return `${trim(n / 1e4)} 万`;
}

/**
 * 破解时间的人话版本。
 *
 * 别报「2 的 118 次方」——那是给同行看的。用户要判断的是
 * 「这件事会不会发生在我身上」，所以给的是**时间**，而且一路换算到
 * 他熟悉的单位：秒 → 分钟 → 小时 → 天 → 年 → 万年 → 亿年 → 宇宙年龄。
 * 过了宇宙年龄就不必再报数了 —— 那个数已经没有意义。
 */
export function crackTimeText(entropyBits: number): string {
  const seconds = secondsToCrack(entropyBits);
  if (seconds < 1) return '一瞬间';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时`;

  const days = seconds / 86400;
  if (days < 365) return `${Math.round(days)} 天`;

  const years = days / 365;
  if (years < 1e4) return `${Math.round(years)} 年`;
  if (years < UNIVERSE_AGE_YEARS) return `${zhNumber(years)}年`;
  return '比宇宙现在的年龄还长';
}

/**
 * 生成器里那句话。
 *
 * ⚠️ 这个模型对**生成出来的**密码是准的：字符是从一个已知大小的池子里
 * 均匀取的，攻击者也知道参数（算法保密不值钱）。对用户自己敲的密码不准 ——
 * `P@ssw0rd1!` 会被算得很高，那要用词典式的判定，见 `@1warden/vault` 的 health。
 */
export function crackSentence(entropyBits: number, score: number): string {
  const time = crackTimeText(entropyBits);
  if (score >= 3) {
    return `就算有人专门造一台每秒试一万亿次的机器来猜它，也需要 ${time}。`;
  }
  if (score === 2) {
    return `一台每秒试一万亿次的机器来猜它，只要 ${time}。重要的账户建议再长一点。`;
  }
  return `一台每秒试一万亿次的机器来猜它，只要 ${time}。别用在需要保护的东西上。`;
}
