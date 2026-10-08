import { FloatingPanel, GeneratorBody, PageHeader } from '@1warden/ui';

/**
 * 生成器 —— **桌面端这里只剩浮层外壳**。
 *
 * 内容本体在 `@1warden/ui` 的 `GeneratorBody`，和扩展弹窗**同一份代码**。
 * 那份以前是两个 app 里各写一遍，而弹窗那份弱得多（没有口令、只有两类
 * 字符、而且**结果被截断看不全**）—— 详见共享组件顶部。
 *
 * ## 为什么是浮层，不是又一屏
 *
 * 生成密码这件事**总是发生在某个上下文里**：要么在改某条记录的密码，
 * 要么刚打开一个注册页。做成整屏会把用户从那个上下文里拽出来，
 * 关掉之后再自己找回去。浮层压在上面，底下的东西还在原处。
 *
 * 扩展弹窗那边不是浮层 —— 它整屏就只有 440px，浮层没有意义，
 * 直接把内容铺在列表那一层。**两个外壳，一份内容。**
 */
export function Generator({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <FloatingPanel
      open={open}
      onClose={onClose}
      labelledBy="generator-title"
      className="max-w-[520px]"
      footer={
        <>
          {/* 自动清空这件事必须说出来 —— 不说的话，用户会以为密码一直躺在剪贴板里 */}
          <span className="min-w-0 truncate">复制后 30 秒自动清空剪贴板</span>
          <span className="shrink-0"><kbd className="text-2xs">esc</kbd> 关闭</span>
        </>
      }
    >
      <PageHeader panel title="生成器" titleId="generator-title" onBack={onClose} onClose={onClose}
        breadcrumbs={[{ label: '保险库', onSelect: onClose }, { label: '生成器' }]} />

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <GeneratorBody />
      </div>
    </FloatingPanel>
  );
}
