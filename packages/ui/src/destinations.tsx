import type { ReactNode } from 'react';
import type { BankAccountFields, DriversLicenseFields, PassportFields } from '@1warden/vault';
import { TypeIcon } from './icons';

/**
 * 导航目的地 —— 桌面端侧栏和弹窗 rail **共用这一份定义**。
 *
 * ## 为什么必须共用
 *
 * 两端各写一份的后果不是「样式不一致」，是**同一个类型在两个地方叫不同的名字**。
 * 真发生过：桌面端写的是「信用卡 / 安全笔记 / 身份信息 / SSH 密钥」，
 * 弹窗写的是「卡片 / 笔记 / 身份 / SSH」—— 用户在桌面端把一条归到「身份信息」，
 * 到弹窗里找不到那个词，只能猜「身份」是不是同一个东西。
 *
 * ## 类型词表
 *
 * ⚠️ **只有这一份。** `unknown` 也要有词：条目的类型字段来自服务端，
 * 遇到我们不认识的类型时显示成「未知类型」比显示成 `raw:7` 强。
 */
export const TYPE_LABEL: Record<string, string> = {
  login: '登录',
  secureNote: '安全笔记',
  card: '信用卡',
  identity: '身份信息',
  sshKey: 'SSH 密钥',
  bankAccount: '银行账户',
  driversLicense: '驾照',
  passport: '护照',
  unknown: '未知类型',
};

/** 类型的展示顺序 —— **不**按字母、不按数量，按「一个人最可能先找哪个」 */
export const TYPE_ORDER = ['login', 'card', 'bankAccount', 'identity', 'driversLicense', 'passport', 'secureNote', 'sshKey'] as const;

/**
 * 身份信息的字段名 → 人话。
 *
 * ⚠️ 和 `TYPE_LABEL` 同一族，也必须只有一份。收进来的时候两边**已经漂了**：
 * 桌面端 `ssn: '身份证号'`、扩展端 `ssn: '证件号'` —— 而后者的那份是
 * 在同一次会话里现写的。**一个会话就能漂，何况几个月。**
 *
 * 取值以桌面端为准（它是参考实现，而且「身份证号」对中国用户更具体）。
 */
export const IDENTITY_LABEL: Record<string, string> = {
  title: '称谓', firstName: '名字', middleName: '中间名', lastName: '姓氏',
  address1: '地址', address2: '地址 2', address3: '地址 3', city: '城市',
  state: '省/州', postalCode: '邮编', country: '国家', company: '公司',
  email: '邮箱', phone: '电话', ssn: '身份证号', username: '用户名',
  passportNumber: '护照号', licenseNumber: '驾照号',
};

/** Native credential/document fields; the editor and both detail views share these labels. */
export const BANK_ACCOUNT_LABEL = {
  bankName: '银行名称', nameOnAccount: '账户姓名', accountType: '账户类型',
  accountNumber: '账号', routingNumber: '路由号码', branchNumber: '分行号码',
  pin: 'PIN 码', swiftCode: 'SWIFT 代码', iban: 'IBAN', bankContactPhone: '银行联系电话',
} as const satisfies Record<keyof BankAccountFields, string>;

export const DRIVERS_LICENSE_LABEL = {
  firstName: '名字', middleName: '中间名', lastName: '姓氏', dateOfBirth: '出生日期',
  licenseNumber: '驾照号码', issuingCountry: '签发国家 / 地区', issuingState: '签发省 / 州',
  issueDate: '签发日期', expirationDate: '到期日期', issuingAuthority: '签发机关', licenseClass: '准驾车型',
} as const satisfies Record<keyof DriversLicenseFields, string>;

export const PASSPORT_LABEL = {
  surname: '姓氏', givenName: '名字', dateOfBirth: '出生日期', sex: '性别', birthPlace: '出生地',
  nationality: '国籍', issuingCountry: '签发国家 / 地区', passportNumber: '护照号码',
  passportType: '护照类型', nationalIdentificationNumber: '国民身份号码',
  issuingAuthority: '签发机关', issueDate: '签发日期', expirationDate: '到期日期',
} as const satisfies Record<keyof PassportFields, string>;

export interface NavDestination {
  /** 稳定的键。类型用 `type:<条目类型>` 前缀，和固定项区分开 */
  key: string;
  label: string;
  icon: ReactNode;
  /** 这一类里有多少条。固定项（收藏等）不传 */
  count?: number;
}

/**
 * 从条目统计出**类型**目的地。
 *
 * ⚠️ 计数为 0 的类型**不出现** —— 列一堆「0」既占地方，又让人以为自己的东西少了。
 * 两端都是这条规则；弹窗早先列死了五个类型（其中常有空的），是这里改掉的。
 *
 * ⚠️ 顺序按 `TYPE_ORDER` 而不是按数量：数量排序会让整个导航在同步之后
 * **重新洗牌**，用户刚记住的位置就变了。桌面端早先按数量降序，也是这里统一的。
 */
export function typeDestinations(
  counts: ReadonlyMap<string, number>,
  iconSize: number,
): NavDestination[] {
  const known = TYPE_ORDER.filter((t) => (counts.get(t) ?? 0) > 0)
    .map((t) => ({ type: t as string, count: counts.get(t) ?? 0 }));
  // 服务端可能有我们不认识的类型 —— 它们也要能进去，排在已知的后面
  const unknown = [...counts.entries()]
    .filter(([t, n]) => n > 0 && !(TYPE_ORDER as readonly string[]).includes(t))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => ({ type, count }));

  return [...known, ...unknown].map(({ type, count }) => ({
    key: `type:${type}`,
    label: TYPE_LABEL[type] ?? type,
    icon: <TypeIcon type={type} size={iconSize} />,
    count,
  }));
}

/** 从条目列表直接统计每个类型有多少条 */
export function countByType(items: readonly { type: string }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.type, (m.get(i.type) ?? 0) + 1);
  return m;
}
