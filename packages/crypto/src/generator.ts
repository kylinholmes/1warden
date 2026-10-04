export const POOLS = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
} as const;

const AMBIGUOUS = /[Il1O0o]/g;

export interface PasswordOptions {
  length?: number;
  lowercase?: boolean;
  uppercase?: boolean;
  digits?: boolean;
  symbols?: boolean;
  avoidAmbiguous?: boolean;
}

/**
 * 无偏随机整数 [0, bound)。
 *
 * ⚠️ 不能用 `randomByte % bound` —— bound 不整除 256 时靠前的值概率更高，
 * 实际熵低于理论值。这里用**拒绝采样**消除模偏差，并按 bound 的大小取足够
 * 多的字节（Fisher–Yates 洗牌需要 bound = 密码长度，可能远大于 256）。
 */
function randomIndex(bound: number): number {
  if (!Number.isInteger(bound) || bound < 1) {
    throw new Error(`randomIndex: bound 必须是正整数，收到 ${bound}`);
  }
  if (bound === 1) return 0;

  const bytesNeeded = Math.ceil(Math.log2(bound) / 8);
  const space = 2 ** (8 * bytesNeeded);
  const limit = space - (space % bound); // 只接受落在完整区间内的值
  const buf = new Uint8Array(bytesNeeded);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    let v = 0;
    for (const b of buf) v = v * 256 + b;
    if (v < limit) return v % bound;
  }
}

/** 取出启用的字符类（已应用「排除易混字符」过滤） */
function enabledClasses(opts: PasswordOptions): string[] {
  const classes: string[] = [];
  if (opts.lowercase ?? true) classes.push(POOLS.lowercase);
  if (opts.uppercase ?? true) classes.push(POOLS.uppercase);
  if (opts.digits ?? true) classes.push(POOLS.digits);
  if (opts.symbols ?? true) classes.push(POOLS.symbols);
  return opts.avoidAmbiguous
    ? classes.map((c) => c.replace(AMBIGUOUS, '')).filter((c) => c.length > 0)
    : classes;
}

export function generatePassword(opts: PasswordOptions = {}): string {
  const length = opts.length ?? 20;
  if (!Number.isInteger(length) || length < 1) throw new Error(`length 必须是正整数，收到 ${length}`);

  const classes = enabledClasses(opts);
  if (classes.length === 0) throw new Error('至少要启用一类字符');
  if (length < classes.length) {
    throw new Error(`length (${length}) 不能小于启用的字符类数 (${classes.length})`);
  }

  const pool = classes.join('');
  // 每类先保底一个，保证生成的密码一定满足所选策略
  const chars = classes.map((c) => c[randomIndex(c.length)]!);
  while (chars.length < length) chars.push(pool[randomIndex(pool.length)]!);

  // Fisher–Yates 洗牌，避免保底字符固定出现在开头
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export interface PassphraseOptions {
  words?: number;
  separator?: string;
  capitalize?: boolean;
  includeNumber?: boolean;
}

// 精简词表（EFF 风格，易读易拼）。完整版应在后续替换为完整 EFF 长词表。
const WORDS = [
  'amber', 'anchor', 'apple', 'arrow', 'atlas', 'autumn', 'bacon', 'badge', 'bamboo', 'banjo',
  'basil', 'beacon', 'beetle', 'bishop', 'bison', 'blossom', 'boulder', 'bracket', 'breeze', 'bronze',
  'bubble', 'cactus', 'camera', 'candle', 'canyon', 'carbon', 'cargo', 'cedar', 'celery', 'cello',
  'cherry', 'cobalt', 'cocoa', 'comet', 'copper', 'coral', 'cosmos', 'cotton', 'crater', 'cricket',
  'crimson', 'crystal', 'cymbal', 'daisy', 'dapper', 'delta', 'denim', 'desert', 'diesel', 'dolphin',
  'donut', 'dragon', 'dynamo', 'eagle', 'echo', 'ember', 'emerald', 'engine', 'fabric', 'falcon',
  'feather', 'fennel', 'ferry', 'fiddle', 'fjord', 'flamingo', 'flint', 'forest', 'fossil', 'galaxy',
  'garden', 'ginger', 'glacier', 'granite', 'guitar', 'harbor', 'hazel', 'helmet', 'hibiscus', 'honey',
  'hummus', 'igloo', 'indigo', 'island', 'ivory', 'jasmine', 'jigsaw', 'jungle', 'kayak', 'kernel',
  'kettle', 'kiwi', 'koala', 'lantern', 'lemon', 'leopard', 'lilac', 'limestone', 'lobster', 'lotus',
  'lunar', 'magnet', 'mango', 'maple', 'marble', 'meadow', 'melon', 'meteor', 'mint', 'mirror',
  'monsoon', 'moose', 'mosaic', 'mountain', 'nectar', 'needle', 'nickel', 'noodle', 'nutmeg', 'oasis',
  'ocean', 'olive', 'onyx', 'opal', 'orbit', 'orchid', 'otter', 'oyster', 'panda', 'papaya',
  'pebble', 'pelican', 'penguin', 'pepper', 'petal', 'piano', 'pigment', 'pillow', 'planet', 'plum',
  'pollen', 'poppy', 'prairie', 'prism', 'pumpkin', 'quartz', 'quilt', 'rabbit', 'radar', 'raven',
  'ribbon', 'river', 'robin', 'rocket', 'rosemary', 'saffron', 'sailor', 'salmon', 'sandal', 'sapphire',
  'saturn', 'sauna', 'scooter', 'sequoia', 'shadow', 'shrimp', 'silver', 'sleigh', 'solar', 'sparrow',
  'spruce', 'squash', 'stellar', 'stone', 'sugar', 'summit', 'sunset', 'sushi', 'syrup', 'tango',
  'teapot', 'tempo', 'thistle', 'thunder', 'timber', 'tomato', 'topaz', 'tornado', 'tortoise', 'tulip',
  'tundra', 'turtle', 'umbrella', 'unicorn', 'valley', 'vanilla', 'velvet', 'violet', 'volcano', 'walnut',
  'waffle', 'willow', 'window', 'winter', 'wizard', 'wombat', 'yarrow', 'yogurt', 'zebra', 'zenith',
];

export function generatePassphrase(opts: PassphraseOptions = {}): string {
  const count = opts.words ?? 4;
  if (!Number.isInteger(count) || count < 1) throw new Error(`words 必须是正整数，收到 ${count}`);
  const separator = opts.separator ?? '-';

  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    let w = WORDS[randomIndex(WORDS.length)]!;
    if (opts.capitalize) w = w[0]!.toUpperCase() + w.slice(1);
    parts.push(w);
  }
  if (opts.includeNumber) parts.push(String(randomIndex(100)));
  return parts.join(separator);
}

export function estimateEntropyBits(password: string, poolSize: number): number {
  if (password.length === 0 || poolSize <= 1) return 0;
  return password.length * Math.log2(poolSize);
}

export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; entropyBits: number } {
  if (pw.length === 0) return { score: 0, entropyBits: 0 };

  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
  if (pool === 0) pool = 26;

  const entropyBits = estimateEntropyBits(pw, pool);
  const score: 0 | 1 | 2 | 3 | 4 =
    entropyBits < 28 ? 0 : entropyBits < 50 ? 1 : entropyBits < 70 ? 2 : entropyBits < 100 ? 3 : 4;
  return { score, entropyBits };
}
