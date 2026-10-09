import { IconCheck, IconCopy } from './icons';
import { CLIPBOARD_CLEAR_MS } from './clipboard';
import { useCopyAction } from './useCopyAction';

/**
 * 复制到剪贴板 —— **桌面端和浏览器插件共用**。
 *
 * ## 为什么必须共用
 *
 * 这段逻辑在仓库里曾经有**四份**拷贝：桌面端的 `CopyButton`、`SecretField`
 * 里内联的一份、`use-quick-bridge` 里的一份，加上弹窗那份（它够不着上面三个，
 * 因为它跑在扩展里而它们住在 desktop 里）。`30_000` 这个数也硬编码了三遍。
 *
 * 它不只是「代码重复」—— 这里面有一条**数据安全规则**：
 *
 * > 到点清空时，只有剪贴板里**还是我们写进去的那个值**时才清。
 *
 * 无脑清空会抹掉用户在这 30 秒里后来复制的东西，那是个数据丢失 bug。
 * 四份拷贝意味着将来只要有人改好其中三份，剩下那份就会继续误删用户的东西 ——
 * 而这种 bug 的表现是「偶尔粘贴出来是空的」，极难归因。
 *
 * ## 两个 API 的分工
 *
 * ⚠️ 常量与那几个纯函数住在 `./clipboard`（无 React），因为离屏文档也要用
 * 同一个数 —— 见那个文件顶部。
 *
 * ## 这个组件只管界面与反馈
 *
 * 取值走 `getValue`、收尾走 `onCopied`，因为这两件事两端确实不同：
 * - 条目字段经 `ApplicationClient.reveal` 按需读取，平台适配器决定本地
 *   调用还是发消息；复制不需要提前把整条记录的密码放进组件。
 * - 剪贴板清空在弹窗那边由**后台的离屏文档**负责 —— 弹窗一关它的定时器
 *   就没了，而这正是「复制完忘了剪贴板里还有密码」最常见的场景
 */

export interface CopyButtonProps {
  /**
   * 取要复制的值，**每次点击都会调用**。
   *
   * 之所以不是直接收 `value`：弹窗要靠它去后台取明文，而那样明文只在
   * 复制那一刻过手。桌面端传 `async () => value` 即可。
   */
  getValue: () => Promise<string>;
  /**
   * 值已写进剪贴板之后。共享页面传 `scheduleClipboardClear`，由入口
   * 安装的平台实现选择本地定时器或扩展后台；Windows 原生写入已经安排清理，
   * 此时无需重复安排。写入失败时不调用回调。
   */
  onCopied?: (value: string) => void | Promise<void>;
  /** 失败时。**不传就静默** —— 但调用方通常应该传，不然用户不知道没复制上 */
  onError?: (e: unknown) => void;
  /** 外观由使用处决定 —— 详情里是安静的小按钮，生成器里它是主操作 */
  className?: string;
  /** 只显示图标（`SecretField` 那种贴在字段右边的用法） */
  iconOnly?: boolean;
  iconSize?: number;
  /** 文字版默认的词 */
  label?: string;
}

/**
 * 复制按钮。
 *
 * ⚠️ 「已复制」的反馈**2 秒**就褪掉，和剪贴板 30 秒后清空是**两件事** ——
 * 早先把它们绑在同一个定时器上，于是按钮会顶着「已复制」三十秒，
 * 看起来像卡住了。
 *
 * 反馈长在按钮上（图标变勾、文字变「已复制」）而不是发提示条：
 * 同一件事说两遍会让人怀疑发生了两件事。
 */
export function CopyButton({
  getValue, onCopied, onError, className = 'btn btn-ghost shrink-0 gap-1.5',
  iconOnly = false, iconSize = 13, label = '复制',
}: CopyButtonProps) {
  const { state, copy } = useCopyAction({ getValue, onCopied, onError });
  const copied = state === 'ok';

  return (
    <button
      type="button"
      onClick={() => { void copy(); }}
      title={copied ? '已复制' : `复制（${CLIPBOARD_CLEAR_MS / 1000} 秒后自动清空剪贴板）`}
      aria-label={copied ? '已复制' : '复制'}
      data-state={copied ? 'ok' : undefined}
      className={className}
    >
      {copied ? <IconCheck size={iconSize} /> : <IconCopy size={iconSize} />}
      {!iconOnly && (copied ? '已复制' : label)}
    </button>
  );
}
