import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  autotypeStatus, autotypeType, autotypeOpenSettings,
  AUTOTYPE_SUCCESS_NOTE, type PermissionState,
} from '../autotype';
import { IconAlert, IconKeyboard } from '@coffer/ui';

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

export function AutotypeAction({ username, getPassword }: {
  username: string | null;
  getPassword: () => Promise<string>;
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
      //
      // 走 Rust 命令而不是前端的 window API：后者需要 ACL 授权，
      // 而 Tauri 的默认窗口权限里没有 minimize（见 lib.rs 的说明）。
      // 之前这里用的是前端 API + `.catch(() => {})`，也就是说**它从来没生效过**。
      await invoke('main_minimize');
      // 给窗口管理器一点时间完成焦点切换
      await new Promise((r) => setTimeout(r, 350));

      const password = await getPassword();
      await autotypeType({ username, password, submit: false });
      setResult({ ok: true, message: AUTOTYPE_SUCCESS_NOTE });
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : '发送按键失败' });
    }
  }

  if (permission === 'denied') {
    return (
      /*
        ⚠️ 这一块是**很多用户的默认状态**（全新安装都还没有辅助功能授权），
        所以它不能长得像一条错误。上一版把整段解释堆在这里，
        结果它比旁边的密码字段还抢眼 —— 一块界面里最响的东西
        不该是「某个功能还不可用」。

        拆成三层：一行说清要做什么、一个按钮、一行才是不放心的那段保证。
      */
      <div className="card-well px-3.5 py-3">
        <p className="flex items-center gap-2 text-xs text-[var(--ink-secondary)]">
          <IconAlert size={14} className="shrink-0 text-[var(--caution)]" />
          需要辅助功能权限才能向其他应用输入
        </p>
        <button
          onClick={() => { void autotypeOpenSettings(); }}
          className="btn btn-quiet mt-2.5 ml-[22px]"
        >
          打开系统设置
        </button>
        <p className="mt-2.5 ml-[22px] text-xs leading-relaxed text-[var(--ink-tertiary)]">
          1Warden 只会往当前焦点发送按键，不会读取任何应用的界面内容。
        </p>
      </div>
    );
  }

  return (
    <div>
      {count === null ? (
        <button onClick={start} disabled={permission === null} className="btn btn-quiet gap-1.5">
          <IconKeyboard size={13} />
          输入到其他应用…
        </button>
      ) : (
        /*
          倒计时用大一号的字 + 强调色：这几秒里用户要完成的动作是
          「切到目标窗口」，提示必须显眼到他不会错过。
        */
        <p className="flex items-center gap-2 text-sm text-[var(--accent)]" role="status">
          <IconKeyboard size={15} className="shrink-0" />
          <span className="tabular-nums font-medium">{count}</span>
          秒后发送，请切换到目标窗口…
        </p>
      )}

      {result && (
        <p
          className="mt-2 flex items-start gap-2 text-xs"
          style={{ color: result.ok ? 'var(--ink-tertiary)' : 'var(--risk)' }}
        >
          {!result.ok && <IconAlert size={13} className="mt-0.5 shrink-0" />}
          <span>{result.message}</span>
        </p>
      )}
    </div>
  );
}
