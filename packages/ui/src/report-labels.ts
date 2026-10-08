/**
 * 安全报告的显示词表 —— **两端共用一份**。
 *
 * ⚠️ 和 `TYPE_LABEL` / `IDENTITY_LABEL` 同一族：**只能是这一份**。
 *
 * 收进来的时候，`GRADE_LABEL` 两边已经漂了：
 *
 *     桌面端  poor: '偏弱'
 *     扩展端  poor: '差'
 *
 * 而扩展端那份是在**同一次会话里现写的** —— 光靠「同一个人写两遍」
 * 维持不了措辞一致，记忆里的说法和上一次就对不上。
 *
 * 取值以桌面端为准（它是参考实现）。`WEAK_REASON` 两边本来就逐字相同，
 * 一并收进来免得将来漂。
 *
 * ⚠️ 键要和 `@1warden/vault` 的 `WeakFinding.reason` / `ScoreGrade` 对齐 ——
 * 那边加一个枚举值，这里就要跟着加，否则界面上会显示成机器串。
 */
export type ScoreGrade = 'excellent' | 'good' | 'fair' | 'poor' | 'critical';

export const GRADE_LABEL: Record<ScoreGrade, string> = {
  excellent: '很好',
  good: '不错',
  fair: '一般',
  poor: '偏弱',
  critical: '危险',
};

/** 弱密码的**机器可读原因** → 人话。键对齐 `WeakFinding.reason` */
export const WEAK_REASON: Record<string, string> = {
  tooShort: '太短',
  common: '常见密码',
  commonWithSuffix: '常见密码加后缀',
  leetSubstitution: '字符替换后的常见密码',
  digitsOnly: '全是数字',
  repeatedChar: '重复字符',
};
