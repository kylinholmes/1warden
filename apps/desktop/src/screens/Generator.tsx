import { useEffect, useState, type ReactNode } from 'react';
import { generatePassword, generatePassphrase, passwordStrength } from '@coffer/crypto';
import { FloatingPanel } from '../components/FloatingPanel';
import { Segmented } from '../components/Segmented';

import { STRENGTH_COLORS, STRENGTH_LABELS, crackSentence } from '@coffer/ui';
import { CopyButton, IconClose, IconDice, scheduleClipboardClear } from '@coffer/ui';

/**
 * 生成器 —— 侧栏里和「导入」并列的一块内容，做成浮层。
 *
 * ## 为什么是浮层，不是又一屏
 *
 * 生成密码这件事**总是发生在某个上下文里**：要么在改某条记录的密码，
 * 要么刚打开一个注册页。做成整屏会把用户从那个上下文里拽出来，
 * 关掉之后再自己找回去。浮层压在上面，底下的东西还在原处。
 *
 * ## 逻辑一行都没有重写
 *
 * 生成走 `@coffer/crypto` 的 `generatePassword` / `generatePassphrase`，
 * 强度走同一个包的 `passwordStrength`。这个仓库里「同一个事实两个来源」
 * 已经栽过好几次（客户端缓存重复密钥、密钥包装、身份头、限流配置），
 * 而密码生成是其中最不该有第二份实现的一种：两份实现**看起来都对**，
 * 直到某一份的模偏差被人发现。
 *
 * ## 说人话
 *
 * 强度反馈不报「熵 128 位」。用户要判断的是「这事会不会发生在我身上」，
 * 所以给的是**时间**：换算到秒 / 分钟 / 天 / 年 / 万年 / 亿年，
 * 直到「比宇宙现在的年龄还长」为止。见 `@coffer/ui` 的 `strength.ts`。
 */

type Kind = 'password' | 'passphrase';

export function Generator({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>('password');

  // 密码
  const [length, setLength] = useState(20);
  const [lower, setLower] = useState(true);
  const [upper, setUpper] = useState(true);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [avoidAmbiguous, setAvoidAmbiguous] = useState(false);

  // 口令
  const [words, setWords] = useState(4);
  const [separator, setSeparator] = useState('-');
  const [capitalize, setCapitalize] = useState(false);
  const [includeNumber, setIncludeNumber] = useState(false);

  /**
   * 「换一个」用 —— 参数没变时也要能重新掷一次。
   *
   * ⚠️ 不能用「把某一项改掉再改回来」这种办法绕，也不要拿 Math.random()
   * 当依赖：那样每次渲染都会重新生成，用户还没看清就变了。
   */
  const [nonce, setNonce] = useState(0);
  const [value, setValue] = useState('');

  const classes = [lower, upper, digits, symbols].filter(Boolean).length;

  /*
   * 参数一变就重新生成：选项和结果必须**始终一致**。
   * 留着一个「按旧选项生成、现在看着却像按新选项生成」的值，是这类界面上
   * 最容易出事的一种状态 —— 用户会复制走它，还以为自己改过长度了。
   */
  useEffect(() => {
    if (!open) return;
    setValue(
      kind === 'password'
        ? generatePassword({ length, lowercase: lower, uppercase: upper, digits, symbols, avoidAmbiguous })
        : generatePassphrase({ words, separator, capitalize, includeNumber }),
    );
  }, [open, nonce, kind, length, lower, upper, digits, symbols, avoidAmbiguous, words, separator, capitalize, includeNumber]);

  const strength = kind === 'password' && value ? passwordStrength(value) : null;

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
      <div className="panel-head">
        <IconDice size={15} className="shrink-0 text-[var(--ink-tertiary)]" />
        <h2 id="generator-title" className="min-w-0 flex-1 truncate text-md font-medium">生成器</h2>
        <button onClick={onClose} aria-label="关闭生成器" title="关闭  esc" className="btn btn-ghost -mr-1 p-1.5">
          <IconClose size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Segmented
          label="生成什么"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'password', label: '密码' },
            { value: 'passphrase', label: '口令' },
          ]}
        />

        {/* 结果在最上面 —— 它是用户来这儿要的东西，不该等他调完参数才看见 */}
        <div className="card-well mt-4 p-3">
          <p className="secret min-h-[46px] break-all text-lg leading-[var(--lh-snug)]">
            {value}
          </p>
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <button onClick={() => setNonce((n) => n + 1)} className="btn btn-quiet gap-1.5">
            <IconDice size={13} />
            换一个
          </button>
          <CopyButton
            getValue={async () => value}
            onCopied={scheduleClipboardClear}
            className="btn btn-primary gap-1.5"
          />
        </div>

        {strength && (
          <div className="mt-3.5 flex items-start gap-2.5">
            <span className="mt-[5px] flex shrink-0 gap-1" aria-hidden>
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className="h-1 w-5 rounded-full transition-colors duration-[var(--dur-base)]"
                  style={{ background: i <= strength.score ? STRENGTH_COLORS[strength.score] : 'var(--border-subtle)' }}
                />
              ))}
            </span>
            <p className="text-xs leading-[var(--lh-prose)] text-[var(--ink-secondary)]">
              <strong className="font-medium text-[var(--ink-primary)]">{STRENGTH_LABELS[strength.score]}</strong>
              {' —— '}
              {crackSentence(strength.entropyBits, strength.score)}
            </p>
          </div>
        )}

        {/*
          口令那一档**不给分数**，也不给秒/年 —— 那两个数都需要词表的大小，
          而词表在 @coffer/crypto 里没有导出。硬编一个「220 个词」写在这里，
          就是从暗处复制了一份事实：词表哪天扩充，这里的数字会**静静地**
          变得保守或乐观，而没有任何东西会提醒。
          所以这里说清楚机制：强度只来自词的个数，加词才有用。
        */}
        {kind === 'passphrase' && (
          <p className="mt-3.5 text-xs leading-[var(--lh-prose)] text-[var(--ink-secondary)]">
            <strong className="font-medium text-[var(--ink-primary)]">{words} 个词</strong>
            {' —— '}
            每个词都是随机取的，词与词之间没有语义联系，所以「像一个短语」帮不了猜的人。
            想让口令更强就再加一个词（每加一个，要试的组合就乘上一整个词表），
            换分隔符、调大小写都没这个用。
            {words <= 3 && ' 三个词偏少，四个起步更稳。'}
          </p>
        )}

        <div className="card mt-5 px-4">
          {kind === 'password' ? (
            <>
              <Row label="长度">
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={8} max={64} value={length}
                    aria-label="密码长度"
                    onChange={(e) => setLength(Number(e.target.value))}
                    className="min-w-0 flex-1"
                  />
                  <span className="tnum w-7 shrink-0 text-right text-sm">{length}</span>
                </div>
              </Row>

              <Row label="包含" hint="至少要留一类字符">
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  <Check checked={upper} onToggle={setUpper} label="大写" disabled={upper && classes === 1} />
                  <Check checked={lower} onToggle={setLower} label="小写" disabled={lower && classes === 1} />
                  <Check checked={digits} onToggle={setDigits} label="数字" disabled={digits && classes === 1} />
                  <Check checked={symbols} onToggle={setSymbols} label="符号" disabled={symbols && classes === 1} />
                </div>
              </Row>

              {/* Il1O0o —— 抄写密码时最容易认错的几个字符，写出来比说「易混字符」清楚 */}
              <Row label="排除易混">
                <Check checked={avoidAmbiguous} onToggle={setAvoidAmbiguous} label="不要 Il1O0o" />
              </Row>
            </>
          ) : (
            <>
              <Row label="词数">
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={3} max={8} value={words}
                    aria-label="词的个数"
                    onChange={(e) => setWords(Number(e.target.value))}
                    className="min-w-0 flex-1"
                  />
                  <span className="tnum w-7 shrink-0 text-right text-sm">{words}</span>
                </div>
              </Row>

              <Row label="分隔符">
                <input
                  value={separator}
                  maxLength={3}
                  aria-label="分隔符"
                  onChange={(e) => setSeparator(e.target.value)}
                  className="field w-[64px] text-center"
                />
              </Row>

              <Row label="首字母大写">
                <Check checked={capitalize} onToggle={setCapitalize} label="Harbor 这样" />
              </Row>

              <Row label="附加数字">
                {/* 生成的是 randomIndex(100)，也就是 0–99 —— 写成「两位」在 7 的时候是错的 */}
                <Check checked={includeNumber} onToggle={setIncludeNumber} label="末尾加 0–99" />
              </Row>
            </>
          )}
        </div>
      </div>
    </FloatingPanel>
  );
}

/**
 * 一行：标签在左，控件在右 —— 和设置面板里那些行是同一种行。
 * 生成器的选项是「改一个参数，上面那串就跟着变」，所以控件贴右边、
 * 参数名贴左边，扫一眼就能对上是哪个在动。
 */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-[var(--border-subtle)] py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-md">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-[var(--ink-tertiary)]">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

function Check({ checked, onToggle, label, disabled }: {
  checked: boolean;
  onToggle: (v: boolean) => void;
  label: string;
  /** 只剩这一类字符时不能取消 —— 否则生成器会抛「至少要启用一类字符」 */
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-1.5 text-sm ${disabled ? 'opacity-60' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
      />
      {label}
    </label>
  );
}
