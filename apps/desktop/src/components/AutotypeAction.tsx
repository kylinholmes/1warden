import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  autotypeStatus, autotypeType, autotypeOpenSettings,
  AUTOTYPE_SUCCESS_NOTE, type PermissionState,
} from '../autotype';

/**
 * 「输入到其他应用」。
 *
 * ## 为什么要倒计时
 *
 * 按键要敲进**别的**应用，所以我们的窗口必须先失去焦点。诚实的做法是
 * 把这件事明确告诉用户：倒计时期间他切到目标窗口，时间到了我们再发按键。
 *
 * 不做「记住上一个前台应用然后自动切回去」—— 那需要读系统状态、在多显示器
 * 和全屏空间下行为还不一致，而代价是用户完全不知道发生了什么。
 *
 * ## 措辞
 *
 * 全程只说「发送按键」，不说「填充」。我们看不到目标控件，无从验证 ——
 * 一句「已填充」在失败时会把用户引到完全错误的方向（他会以为是自己输错了）。
 */
const COUNTDOWN_SECONDS = 3;

export function AutotypeAction({ username, password }: {
  username: string | null;
  password: string | null;
}) {
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    autotypeStatus()
      .then((s) => setPermission(s.permission))
      .catch(() => setPermission('denied'));
  }, []);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  if (password === null) return null;

  function start() {
    setResult(null);
    setCount(COUNTDOWN_SECONDS);

    timer.current = setInterval(() => {
      setCount((n) => {
        if (n === null) return null;
        if (n > 1) return n - 1;

        // 归零：停表、让出焦点、发按键
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        void fire();
        return null;
      });
    }, 1000);
  }

  async function fire() {
    try {
      // 先最小化自己。用户此刻应该已经切到目标窗口了，但万一没有，
      // 这一步能把焦点还给上一个应用 —— 否则按键会敲进我们自己的界面。
      await getCurrentWindow().minimize().catch(() => { /* 有些平台不支持 */ });
      // 给窗口管理器一点时间完成焦点切换
      await new Promise((r) => setTimeout(r, 350));

      await autotypeType({ username, password: password as string, submit: false });
      setResult({ ok: true, message: AUTOTYPE_SUCCESS_NOTE });
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : '发送按键失败' });
    }
  }

  if (permission === 'denied') {
    return (
      <div className="mt-2 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3">
        <p className="mb-2 text-[var(--text-xs)] leading-relaxed text-[var(--ink-secondary)]">
          要向其他应用输入，需要在「系统设置 → 隐私与安全性 → 辅助功能」里
          勾选 Coffer。<strong className="font-medium">Coffer 只会往当前焦点发送按键，
          不会读取任何应用的界面内容。</strong>
        </p>
        <button
          onClick={() => { void autotypeOpenSettings(); }}
          className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-2.5 py-1 text-[var(--text-xs)] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-hover)]"
        >
          打开系统设置
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2">
      {count === null ? (
        <button
          onClick={start}
          disabled={permission === null}
          className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] px-2.5 py-1 text-[var(--text-xs)] text-[var(--ink-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
        >
          输入到其他应用…
        </button>
      ) : (
        <p className="text-[var(--text-xs)] text-[var(--accent)]">
          {count} 秒后发送，请切换到目标窗口…
        </p>
      )}

      {result && (
        <p
          className="mt-1.5 text-[var(--text-xs)]"
          style={{ color: result.ok ? 'var(--ink-tertiary)' : 'var(--risk)' }}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
