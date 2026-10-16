import { focusedPlan, type InlineField, type InlineTarget } from './inline-fields';
import { ext } from './ext-api';
import type { InlineAccounts, InlineOtp, InlineReply } from './inline-accounts';

/** The chooser displays short-lived codes; passwords and TOTP seeds never enter it. */
export function installInlinePicker(readFields: () => InlineField[], credentials?: {
  nonce: string;
  suppress(field: HTMLInputElement): boolean;
  canGenerate(field: HTMLInputElement): boolean;
  openGenerator(field: HTMLInputElement): void;
  onOpen(): void;
}): void {
  // The existing fill implementation targets the top document only.
  if (window.top !== window.self) return;

  let anchor: HTMLInputElement | null = null;
  let host: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let status: HTMLParagraphElement | null = null;
  let choices: HTMLDivElement | null = null;
  let buttons: HTMLButtonElement[] = [];
  let request = 0;
  let busy = false;
  let restoringFocus = false;
  let awaitingUnlock = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pageUrl = location.href;
  let target: InlineTarget | null = null;
  let otpTimer: ReturnType<typeof setInterval> | null = null;
  let nextOtpRefresh = 0;
  let pendingRefresh: number | null = null;
  const otpRows = new Map<string, { otp: InlineOtp | null; button: HTMLButtonElement; title: HTMLSpanElement;
    username: HTMLSpanElement | null; code: HTMLSpanElement; timer: HTMLSpanElement; countdown: HTMLSpanElement }>();

  function close(restoreFocus = false): void {
    const previous = anchor;
    request++;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (otpTimer !== null) clearInterval(otpTimer);
    otpTimer = null;
    pendingRefresh = null;
    otpRows.clear();
    awaitingUnlock = false;
    busy = false;
    host?.remove();
    host = panel = choices = null;
    status = null;
    anchor = null;
    target = null;
    buttons = [];
    if (restoreFocus && previous?.isConnected) {
      restoringFocus = true;
      previous.focus({ preventScroll: true });
      restoringFocus = false;
    }
  }

  function position(): void {
    if (!host || !anchor || !panel) return;
    if (!anchor.isConnected || pageUrl !== location.href) { close(); return; }
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) { close(); return; }
    const width = Math.min(Math.max(rect.width, 280), 360, innerWidth - 16);
    host.style.setProperty('width', `${width}px`, 'important');
    const below = innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const placeAbove = below < Math.min(panel.scrollHeight, 200) && above > below;
    const available = Math.max(40, Math.min(320, placeAbove ? above : below, innerHeight - 16));
    panel.style.maxHeight = `${available}px`;
    const height = panel.getBoundingClientRect().height;
    const top = placeAbove ? rect.top - height - 6 : rect.bottom + 6;
    host.style.setProperty('left', `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`, 'important');
    host.style.setProperty('top', `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`, 'important');
  }

  function focusButton(index: number): void {
    if (!buttons.length) return;
    const button = buttons[(index + buttons.length) % buttons.length]!;
    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: 'nearest' });
  }

  function createHost(): void {
    host = document.createElement('div');
    host.dataset['onewardenInline'] = '';
    host.dataset['kind'] = target!.kind;
    // Closed shadow DOM isolates labels/styles from ordinary page scripts.
    const shadow = host.attachShadow({ mode: 'closed' });
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;z-index:2147483647!important;color-scheme:light dark!important;';
    const style = document.createElement('style');
    style.textContent = `
      :host { font: 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        --onewarden-paper:#fff; --onewarden-ink:#202b3c; --onewarden-muted:#43556e;
        --onewarden-border:#bbcee8; --onewarden-accent:#0667e8; --onewarden-tint:#ecf3ff;
        --onewarden-hover:#dbeaff; --onewarden-ring:#2779ee; --onewarden-shadow:#26458029; }
      @media (prefers-color-scheme:dark) {
        :host { --onewarden-paper:#24344a; --onewarden-ink:#f1f6ff; --onewarden-muted:#c5d2e4;
          --onewarden-border:#4b6382; --onewarden-accent:#8ac0ff; --onewarden-tint:#243f62;
          --onewarden-hover:#244c7a; --onewarden-ring:#6ba8ff; --onewarden-shadow:#030b1d66; }
      }
      * { box-sizing: border-box; }
      .panel { overflow:auto; background:var(--onewarden-paper); color:var(--onewarden-ink); border:1px solid var(--onewarden-border);
        border-radius:12px; box-shadow:0 8px 30px var(--onewarden-shadow); padding:6px; }
      .heading { padding:8px 10px 6px; font-size:12px; font-weight:650; color:var(--onewarden-accent); }
      .status { margin:0; padding:8px 10px; color:var(--onewarden-muted); font-size:13px; }
      .status:empty { display:none; }
      button { display:block; width:100%; border:0; border-radius:7px; padding:10px;
        background:transparent; color:inherit; text-align:left; cursor:pointer; font:inherit; }
      :host([data-state='locked']) button { background:var(--onewarden-tint); color:var(--onewarden-accent); }
      button:hover,button:focus-visible { background:var(--onewarden-hover); outline:2px solid var(--onewarden-ring); outline-offset:-2px; }
      button:disabled { cursor:wait; opacity:.6; }
      .title,.username { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .title { font-weight:600; }
      .username { margin-top:2px; color:var(--onewarden-muted); font-size:12px; }
      .otp-line { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:8px; }
      .otp-code { font:650 24px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.06em; font-variant-numeric:tabular-nums; }
      .otp-timer { display:grid; place-items:center; position:relative; width:32px; height:32px; flex:none;
        border-radius:50%; background:conic-gradient(var(--onewarden-accent) var(--remaining),var(--onewarden-border) 0); }
      .otp-timer::before { content:''; position:absolute; inset:2px; border-radius:50%; background:var(--onewarden-paper); }
      .otp-countdown { position:relative; font-size:10px; font-variant-numeric:tabular-nums; }
      .otp-code[data-expiring='true'] { color:var(--onewarden-muted); }
    `;
    panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    const title = target?.kind === 'totp' ? '1Warden · 验证码' : '1Warden · 此网站的账号';
    panel.setAttribute('aria-label', title);
    const heading = document.createElement('div');
    heading.className = 'heading';
    heading.textContent = title;
    status = document.createElement('p');
    status.className = 'status';
    status.setAttribute('role', 'status');
    choices = document.createElement('div');
    panel.append(heading, status, choices);
    shadow.append(style, panel);
    shadow.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      if (!e.isTrusted) return;
      const index = buttons.indexOf(shadow.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        focusButton(index + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault(); e.stopPropagation();
        focusButton(e.key === 'Home' ? 0 : buttons.length - 1);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); close(true);
      }
    });
    document.documentElement.append(host);
    // Top layer avoids transforms and page stacking contexts. Older browsers
    // retain the fixed-position fallback.
    if (typeof host.showPopover === 'function') {
      host.popover = 'manual';
      try { host.showPopover(); } catch { /* fixed-position fallback */ }
    }
    if (target?.kind === 'totp') {
      nextOtpRefresh = Date.now() + 1000;
      otpTimer = setInterval(() => {
        if (!host || !anchor?.isConnected || pageUrl !== location.href || document.hidden) { close(); return; }
        paintCodes();
        if (!busy && pendingRefresh === null && host.dataset['state'] === 'accounts' && Date.now() >= nextOtpRefresh) {
          void refresh(true);
        }
      }, 250);
    }
  }

  function paintCodes(): void {
    const now = Date.now();
    for (const row of otpRows.values()) {
      const remaining = row.otp ? Math.max(0, Math.ceil((row.otp.expiresAt - now) / 1000)) : 0;
      if (remaining === 0) row.otp = null;
      const code = row.otp?.code ?? '';
      row.code.textContent = code ? (/^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code) : '··· ···';
      row.code.setAttribute('aria-label', code ? `验证码 ${code.split('').join(' ')}` : '验证码正在刷新');
      row.code.dataset['expiring'] = String(remaining <= 5);
      row.countdown.textContent = remaining ? `${remaining}s` : '…';
      row.timer.setAttribute('aria-label', remaining ? `${remaining} 秒后刷新` : '正在刷新');
      row.timer.style.setProperty('--remaining', `${row.otp ? Math.min(1, remaining / row.otp.period) * 360 : 0}deg`);
    }
  }

  function message(text: string): void {
    if (status) status.textContent = text;
    position();
  }

  function errorText(error: unknown, fallback: string): string {
    const text = error instanceof Error ? error.message : fallback;
    if (/receiving end does not exist|could not establish connection|message port closed/i.test(text)) {
      return '扩展尚未就绪，请重试；如果刚更新扩展，请刷新网页。';
    }
    if (/extension context invalidated/i.test(text)) return '扩展已更新，请刷新网页后重新选择账号。';
    return text;
  }

  function action(title: string, username: string | null, run: () => void, preview?: { id: string; otp: InlineOtp }): void {
    const button = document.createElement('button');
    button.type = 'button';
    const label = document.createElement('span');
    label.className = 'title';
    label.textContent = title;
    button.append(label);
    let detail: HTMLSpanElement | null = null;
    if (username !== null) {
      detail = document.createElement('span');
      detail.className = 'username';
      detail.textContent = username || '未设置用户名';
      button.append(detail);
    }
    if (preview) {
      const line = document.createElement('span'); line.className = 'otp-line';
      const code = document.createElement('span'); code.className = 'otp-code';
      const timer = document.createElement('span'); timer.className = 'otp-timer';
      const countdown = document.createElement('span'); countdown.className = 'otp-countdown';
      timer.append(countdown); line.append(code, timer); button.append(line);
      otpRows.set(preview.id, { otp: preview.otp, button, title: label, username: detail, code, timer, countdown });
    }
    button.addEventListener('click', (event) => {
      if (event.isTrusted && !busy) run();
    });
    buttons.push(button);
    choices?.append(button);
  }

  async function choose(itemId: string): Promise<void> {
    const version = ++request;
    busy = true;
    buttons.forEach((button) => { button.disabled = true; });
    message('正在填充…');
    try {
      const reply = await ext.runtime.sendMessage({ type: '1warden:inline-fill', itemId, target,
        nonce: credentials?.nonce, documentUrl: pageUrl }) as InlineReply;
      if (version !== request || !host) return;
      if (!reply || 'error' in reply) throw new Error(reply && 'error' in reply ? reply.error : '扩展没有响应，请重试');
      close();
    } catch (error) {
      if (version !== request || !host) return;
      busy = false;
      buttons.forEach((button) => { button.disabled = false; });
      message(errorText(error, '未能填充，请重试'));
    }
  }

  function scheduleRefresh(): void {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    if (!awaitingUnlock || !host) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (host && awaitingUnlock) void refresh(true);
    }, 1000);
  }

  async function unlock(): Promise<void> {
    awaitingUnlock = true;
    message('请在 1Warden 弹窗中解锁，再回到此处选择填充。');
    // Opening a native action popup can leave its Promise pending; observing
    // the completed unlock must not depend on that Promise settling.
    scheduleRefresh();
    // Send directly from this click; some browsers require a live user gesture.
    try {
      const reply = await ext.runtime.sendMessage({ type: '1warden:inline-unlock' }) as InlineReply;
      if (!host || !awaitingUnlock) return;
      if (reply && 'error' in reply) message(reply.error);
    } catch {
      message('请点击浏览器工具栏中的 1Warden 图标解锁，然后回到此输入框选择账号。');
    }
  }

  async function refresh(quiet = false): Promise<void> {
    if (!host || busy) return;
    const version = ++request;
    pendingRefresh = version;
    nextOtpRefresh = Date.now() + 1000;
    if (!quiet) message(target?.kind === 'totp' ? '正在查找验证码…' : '正在查找账号…');
    try {
      const reply = await ext.runtime.sendMessage({ type: '1warden:inline-accounts', target,
        nonce: credentials?.nonce, documentUrl: pageUrl }) as InlineAccounts | { error: string };
      if (version !== request || !host) return;
      if (!reply || 'error' in reply) throw new Error(reply && 'error' in reply ? reply.error : '扩展没有响应，请重试');
      if (!reply.unlocked && quiet && awaitingUnlock && host.dataset['state'] === 'locked') { scheduleRefresh(); return; }
      // Keep the existing buttons during ticking/rollover so hover, scroll and
      // keyboard focus remain on the account the user is about to choose.
      if (reply.unlocked && target?.kind === 'totp' && otpRows.size > 0 && otpRows.size === reply.accounts.length
        && reply.accounts.every(account => otpRows.has(account.id) && account.otp)) {
        for (const account of reply.accounts) {
          const row = otpRows.get(account.id)!;
          row.otp = account.otp!; row.title.textContent = account.title;
          if (row.username) row.username.textContent = account.username || '未设置用户名';
        }
        paintCodes(); return;
      }
      const hadFocus = document.activeElement === host;
      otpRows.clear();
      choices?.replaceChildren();
      buttons = [];
      host.dataset['state'] = reply.unlocked ? (reply.accounts.length ? 'accounts' : 'empty') : 'locked';
      if (!reply.unlocked) {
        message(target?.kind === 'totp' ? '解锁保险库以填入此网站的验证码' : '解锁保险库以查看此网站的账号');
        action('解锁 1Warden', null, () => { void unlock(); });
      } else {
        awaitingUnlock = false;
        if (refreshTimer !== null) clearTimeout(refreshTimer);
        refreshTimer = null;
        message(reply.accounts.length ? ''
          : target?.kind === 'totp' ? '此网站没有可用的验证码。请在 1Warden 的对应账号中配置 TOTP，或使用你的验证器。'
            : '此网站没有匹配的账号。登录后可按提示保存到 1Warden。');
        for (const account of reply.accounts) {
          const id = account.id;
          action(account.title, account.username, () => { void choose(id); },
            target?.kind === 'totp' && account.otp ? { id, otp: account.otp } : undefined);
        }
        paintCodes();
      }
      if (reply.unlocked && anchor && target?.kind === 'login' && credentials?.canGenerate(anchor)) {
        const field = anchor;
        action('生成新密码…', null, () => { close(true); credentials.openGenerator(field); });
      }
      // Removing the focused unlock button fires focusout. Move focus into the
      // replacement choices before its dismissal check runs.
      if (hadFocus && buttons.length) focusButton(0);
      position();
    } catch (error) {
      if (version !== request || !host) return;
      awaitingUnlock = false;
      const hadFocus = document.activeElement === host;
      otpRows.clear();
      choices?.replaceChildren();
      buttons = [];
      host.dataset['state'] = 'error';
      message(errorText(error, '无法读取账号，请重试'));
      action('重试', null, () => { void refresh(); });
      if (hadFocus) focusButton(0);
      position();
    } finally {
      if (pendingRefresh === version) pendingRefresh = null;
    }
  }

  function eligible(target: EventTarget | null): target is HTMLInputElement {
    if (!(target instanceof HTMLInputElement) || target.disabled || target.readOnly) return false;
    if (credentials?.suppress(target)) return false;
    const fields = readFields();
    const index = Array.from(document.querySelectorAll('input, textarea')).indexOf(target);
    return focusedPlan(fields, index) !== null;
  }

  function show(event: Event): void {
    if (!event.isTrusted || restoringFocus || busy) return;
    if (event.target instanceof HTMLInputElement && credentials?.suppress(event.target)) { close(); return; }
    if (!eligible(event.target)) return;
    if (host && anchor === event.target) return;
    if (!document.documentElement) return;
    close();
    credentials?.onOpen();
    anchor = event.target;
    const index = Array.from(document.querySelectorAll('input, textarea')).indexOf(anchor);
    target = { index, kind: focusedPlan(readFields(), index)!.kind };
    pageUrl = location.href;
    createHost();
    position();
    void refresh();
  }

  document.addEventListener('focusin', show, true);
  document.addEventListener('click', show, true);
  document.addEventListener('pointerdown', (event) => {
    if (host && event.target !== anchor && !event.composedPath().includes(host)) close();
  }, true);
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!busy && !awaitingUnlock && host && document.hasFocus()
        && document.activeElement !== anchor && document.activeElement !== host) close();
    }, 0);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (!event.isTrusted || !host || event.target !== anchor) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (buttons.length) {
        event.preventDefault(); event.stopImmediatePropagation();
        focusButton(event.key === 'ArrowDown' ? 0 : buttons.length - 1);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close(true);
    }
  }, true);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  window.addEventListener('pagehide', () => close());
  document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
  window.addEventListener('focus', () => { if (host && !busy) void refresh(awaitingUnlock); });
  ext.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { type?: string })?.type === '1warden:credential-refresh' && host && target?.kind === 'totp') {
      for (const row of otpRows.values()) row.otp = null;
      paintCodes();
      // A locked background can broadcast this while answering our own request.
      // Do not invalidate that in-flight response or start a refresh loop.
      if (!busy && pendingRefresh === null && host.dataset['state'] === 'accounts') void refresh(true);
    }
  });
}
