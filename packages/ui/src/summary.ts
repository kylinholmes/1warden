/**
 * 列表用的**摘要** —— 一份条目在列表里需要知道的全部。
 *
 * ## 为什么要有这一层
 *
 * 两端的数据来源不同，而且这个不同**抹不掉**：
 *
 * | | 桌面端 | 扩展端 |
 * |---|---|---|
 * | 条目从哪来 | `VaultClient` 在进程内，直接 `await` | `runtime.sendMessage` 问 background |
 * | 明文在哪 | 就在这个进程里 | **不出 background** |
 *
 * 扩展端刻意不让明文进弹窗（spec 不变量 S1），所以共享的列表**不能**按
 * `VaultItem` 设计 —— 那样等于要求弹窗也拿到整条。按摘要设计是唯一
 * 两端都成立的做法，代价是桌面端也要降一级（它本来可以直接用整条）。
 *
 * ## ⚠️ 这个类型原来有三份
 *
 * | 在哪 | 形态 |
 * |---|---|---|
 * | `extension/popup/Popup.tsx` | 定义 |
 * | `extension/background.ts` 的 `summarise` | 生产 |
 * | `preview-extension/stub-chrome.ts` | **手写的一份假数据** |
 *
 * 第三份是最要命的：它是**仪器**，而仪器和真实类型脱节会把「仪器坏了」
 * 显示成「产品坏了」—— 那个文件顶上就记着一次（`iconDomain` 是后加的，
 * 桩没跟上，于是预览里每个条目的图标都没了，而那个样子和产品坏了长得一样）。
 * 桩现在导的是这里的 `summarise`，脱节在类型上就不成立了。
 *
 * ## ⚠️ 不含密码与验证码
 *
 * 只报「有没有」，不报值本身。弹窗要填充时再让 background 自己去取 ——
 * 少送出去一次就少一分风险，而列表本来也没有任何理由需要看到它们。
 */
import { avatarOf, hasTotp, iconDomainOf, summaryOf, type VaultItem } from '@1warden/vault';

export interface ItemSummary {
  id: string;
  /** 原始名字。解不开的时候**不要**在这里替换成占位词 —— 见 `nameFailed` */
  name: string;
  /**
   * 名字解不开（独立密钥缺失等）。
   *
   * ⚠️ 和 `name` 分开，**不要**把「无法解密」这五个字写进 `name`。
   * 两者的区别是**样式**：`ItemRow` 拿到 `nameFailed` 会把这一行画成斜体、
   * 弱化成三级墨 —— 那是在告诉用户「这条不是空的，是解不开」。
   * 揉进字符串的话这层意思就没了，而且搜索、排序、复制都会拿到那五个字。
   */
  nameFailed: boolean;
  username: string | null;
  hasPassword: boolean;
  hasTotp: boolean;
  uris: string[];
  favorite: boolean;
  /** 所属文件夹。只是 id —— 名字在另一端单独给（见下） */
  folderId: string | null;
  createdAt: string;
  updatedAt: string;

  /*
   * ── 显示用的字段 ──
   *
   * ⚠️ 这三个是**算好了随摘要过来**的，不是调用方自己算。
   *
   * 因为算它们需要整条 `VaultItem`，而弹窗拿不到。在两端各算一遍的后果
   * 是规则漂 —— 同一条记录在两个地方显示成不同的东西，而没有任何东西会报错。
   */
  type: string;
  summary: string | null;
  iconDomain: string | null;
  avatarText: string;
  avatarHue: number;
}

/**
 * 整条 → 摘要。
 *
 * 扩展端在 `background.ts` 里调它（那里同时握有整条和网络），
 * 桌面端在渲染列表前调它。**两端同一个函数** —— 这就是这个文件的意义。
 */
export function summarise(i: VaultItem): ItemSummary {
  const av = avatarOf(i);
  return {
    id: i.id,
    name: i.name,
    nameFailed: i.nameFailed,
    username: i.login?.username ?? null,
    hasPassword: i.login?.password != null,
    hasTotp: hasTotp(i),
    uris: i.login?.uris.map((u) => u.uri) ?? [],
    favorite: i.favorite,
    /*
     * 文件夹只带 id，不带名字：名字是**整个库**的一份（`1warden:folders`
     * 那条消息单独给），跟着每条摘要重复几十遍没道理。
     */
    folderId: i.folderId,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    type: i.type,
    summary: summaryOf(i),
    iconDomain: iconDomainOf(i),
    avatarText: av.text,
    avatarHue: av.hue,
  };
}
