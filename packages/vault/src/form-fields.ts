/**
 * 表单字段识别 —— 决定「哪个框填什么」。
 *
 * ⚠️ 与 URL 匹配一样，这里填错也是安全问题：把验证码填进用户名框会毁掉这次
 * 登录，把新密码填进「当前密码」框会让改密码失败，而把密码填进一个叫
 * `search` 的框则可能把它发到服务器日志里。
 *
 * 所以规则是**层层收紧**的：先用作者显式给出的 `autocomplete`，没有才靠
 * 名称/标签猜，最后才靠位置。任何一步拿不准就留空 —— 不填比填错好。
 *
 * ⚠️ 这个模块**不碰 DOM**。读取 DOM 是调用方的事（浏览器扩展里是 content
 * script），传进来的是已经读好的描述。这样才能在 node 里跑测试，
 * 也才能被将来的桌面端原生自动填充复用。
 */

/** 一个输入框的可见线索。调用方负责从 DOM 里读出来。 */
export interface FieldDescriptor {
  /** `input[type]` 的小写值，缺省视为 `text` */
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
  ariaLabel: string;
  /** `<label>` 的可见文字（含 for= 关联与包裹式两种） */
  labelText: string;
  isVisible: boolean;
  isDisabled: boolean;
  isReadOnly: boolean;
  /** 当前已有的值 —— 已经填过的框不该被当成「待填的用户名框」 */
  value?: string;
}

/** 各类字段在字段数组里的下标 */
export interface FieldPlan {
  username?: number;
  /** 当前密码（登录、或改密码时的旧密码） */
  password?: number;
  /** 新密码（注册、改密码） */
  newPassword?: number;
  /** 再次输入新密码 */
  confirmPassword?: number;
  totp?: number;
}

/** 能拿来当文本框用的 input 类型 */
const TEXTUAL = new Set(['text', 'email', 'tel', 'url', 'number', '']);

/** 明确不是「输入内容」的控件 —— 认错了会做出很怪的事 */
const NON_INPUT = new Set(['submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color', 'hidden']);

function norm(s: string | undefined): string {
  return (s ?? '').toLowerCase();
}

/** 把一个字段的各类线索拼成一段可搜索的文字 */
function haystack(f: FieldDescriptor): string {
  return [
    f.name, f.id, f.autocomplete, f.placeholder, f.ariaLabel, f.labelText,
  ].map(norm).join(' ');
}

function isUsable(f: FieldDescriptor): boolean {
  return f.isVisible && !f.isDisabled && !f.isReadOnly && !NON_INPUT.has(norm(f.type));
}

function isTextual(f: FieldDescriptor): boolean {
  return TEXTUAL.has(norm(f.type));
}

function isPassword(f: FieldDescriptor): boolean {
  return norm(f.type) === 'password';
}

/** 「确认 / 再次输入」这类字眼 —— 中英都要认 */
const CONFIRM_HINT = /confirm|repeat|again|retype|verify|确认|再次|重复|再输/;

/** 「新密码」的字眼 */
const NEW_HINT = /new|create|choose|设置|新密码|新/;

/** 「当前 / 旧密码」的字眼 */
const CURRENT_HINT = /current|old|existing|当前|原|旧/;

/** 验证码类字段的名称线索 */
const CODE_HINT = /(^|[^a-z])(otp|totp|mfa|2fa)([^a-z]|$)|one.?time|verif|auth.?code|security.?code|验证码|动态码|令牌/;

/** 明显是搜索的框 —— 它们在登录表单里很常见，但绝不能当用户名 */
const SEARCH_HINT = /search|query|filter|搜索|查询|筛选/;

/**
 * 判断这是不是一个登录表单。
 *
 * 除了「有密码框」，还要认**多步登录的第一屏**：那时候页面上只有邮箱框，
 * 但作者通常会给 `autocomplete="username"` —— 那是比位置可靠得多的信号。
 */
export function isLikelyLoginForm(fields: readonly FieldDescriptor[]): boolean {
  const usable = fields.filter(isUsable);
  if (usable.some(isPassword)) return true;
  return usable.some((f) => norm(f.autocomplete) === 'username');
}

/**
 * 把字段分配到各个角色。
 *
 * 策略（按可靠性排序）：
 *   1. `autocomplete` —— 网页作者显式声明，最可靠
 *   2. 名称 / 标签 / 占位符的文字线索
 *   3. 位置 —— 密码框**之前**最近的可用文本框当用户名
 */
export function classifyFields(fields: readonly FieldDescriptor[]): FieldPlan {
  const plan: FieldPlan = {};

  // ⚠️ `exactOptionalPropertyTypes` 下，给可选属性显式赋 `undefined` 是**类型错误**。
  // 而这里每个角色都是「找到了就写、没找到就不写」，所以统一走这个口子。
  const assign = (key: keyof FieldPlan, value: number | undefined): void => {
    if (value === undefined) return;
    (plan as Record<string, number>)[key] = value;
  };
  const usable = fields.map((f, i) => ({ f, i })).filter(({ f }) => isUsable(f));
  const passwords = usable.filter(({ f }) => isPassword(f));

  // ── 用户名 ──
  const explicitUser = usable.find(({ f }) => norm(f.autocomplete) === 'username');
  if (explicitUser) {
    assign('username', explicitUser.i);
  } else if (passwords.length > 0) {
    assign('username', pickUsernameBefore(usable, passwords[0]!.i));
  }

  // ── 验证码 ──
  // 必须在密码分配**之前**做：名叫 `otp` 的框如果被当成密码就麻烦了，
  // 反过来也不行 —— 所以先把 code 框圈出来，后面分配密码时跳过它
  const codeField = usable.find(({ f }) =>
    norm(f.autocomplete) === 'one-time-code'
    || (!isPassword(f) && isTextual(f) && CODE_HINT.test(haystack(f))));
  if (codeField) assign('totp', codeField.i);

  // ── 密码 ──
  const pwIndices = passwords.map(({ i }) => i);
  if (pwIndices.length === 1) {
    // 只有一个密码框：登录，或者「只填密码」的二次验证
    assign('password', pwIndices[0]);
  } else if (pwIndices.length === 2) {
    // 两个密码框：注册（新 + 确认）或改密码（旧 + 新）。
    //
    // ⚠️ 判定顺序有讲究：**先看第二个框是不是「确认」**。注册表单里第一个
    // 框常常只叫 `pw` / `password`，一点「新」的暗示都没有，但它后面跟着
    // 一个「确认密码」——那才是这个表单是注册的确定信号。
    // 只看第一个框会把注册当成改密码，把旧密码填进「新密码」里。
    const [first, second] = [passwords[0]!.f, passwords[1]!.f];
    if (CONFIRM_HINT.test(haystack(second)) || looksLikeNewPassword(first)) {
      assign('newPassword', pwIndices[0]);
      assign('confirmPassword', pwIndices[1]);
    } else {
      assign('password', pwIndices[0]);
      assign('newPassword', pwIndices[1]);
    }
  } else if (pwIndices.length >= 3) {
    // 三个：当前 + 新 + 确认
    assign('password', pwIndices[0]);
    assign('newPassword', pwIndices[1]);
    assign('confirmPassword', pwIndices[2]);
  }

  return plan;
}

function looksLikeNewPassword(f: FieldDescriptor): boolean {
  const auto = norm(f.autocomplete);
  if (auto === 'new-password') return true;
  if (auto === 'current-password') return false;
  return NEW_HINT.test(haystack(f));
}

/**
 * 密码框**之前**最近的可用文本框。
 *
 * 只看前面：登录表单里密码框之后出现的文本框几乎都是搜索、订阅之类，
 * 把密码交到它们手里毫无道理。
 */
function pickUsernameBefore(
  usable: readonly { f: FieldDescriptor; i: number }[], passwordIndex: number,
): number | undefined {
  for (let k = usable.length - 1; k >= 0; k--) {
    const { f, i } = usable[k]!;
    if (i >= passwordIndex) continue;
    if (!isTextual(f) || isPassword(f)) continue;
    if (SEARCH_HINT.test(haystack(f))) continue;
    // 已经有内容的框多半是搜索/筛选，不是等着填的用户名
    if (norm(f.value).length > 0) continue;
    return i;
  }
  return undefined;
}
