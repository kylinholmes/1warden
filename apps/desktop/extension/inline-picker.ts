import { classifyFields, type FieldDescriptor } from '@coffer/vault';
import { ext } from './ext-api';
import type { InlineAccounts, InlineReply } from './inline-accounts';

/** Page-resident UI receives only matched account labels, never vault secrets. */
export function installInlinePicker(readFields: () => FieldDescriptor[]): void {
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

  function close(restoreFocus = false): void {
    const previous = anchor;
    request++;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    awaitingUnlock = false;
    busy = false;
    host?.remove();
    host = panel = choices = null;
    status = null;
    anchor = null;
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
    host.dataset['cofferInline'] = '';
    // Closed shadow DOM isolates labels/styles from ordinary page scripts.
    const shadow = host.attachShadow({ mode: 'closed' });
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;z-index:2147483647!important;color-scheme:light dark!important;';
    const style = document.createElement('style');
    style.textContent = `
      :host { font: 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        --coffer-paper:#fff; --coffer-ink:#202b3c; --coffer-muted:#43556e;
        --coffer-border:#bbcee8; --coffer-accent:#0667e8; --coffer-tint:#ecf3ff;
        --coffer-hover:#dbeaff; --coffer-ring:#2779ee; --coffer-shadow:#26458029; }
      @media (prefers-color-scheme:dark) {
        :host { --coffer-paper:#24344a; --coffer-ink:#f1f6ff; --coffer-muted:#c5d2e4;
          --coffer-border:#4b6382; --coffer-accent:#8ac0ff; --coffer-tint:#243f62;
          --coffer-hover:#244c7a; --coffer-ring:#6ba8ff; --coffer-shadow:#030b1d66; }
      }
      * { box-sizing: border-box; }
      .panel { overflow:auto; background:var(--coffer-paper); color:var(--coffer-ink); border:1px solid var(--coffer-border);
        border-radius:12px; box-shadow:0 8px 30px var(--coffer-shadow); padding:6px; }
      .heading { padding:8px 10px 6px; font-size:12px; font-weight:650; color:var(--coffer-accent); }
      .status { margin:0; padding:8px 10px; color:var(--coffer-muted); font-size:13px; }
      .status:empty { display:none; }
      button { display:block; width:100%; border:0; border-radius:7px; padding:10px;
        background:transparent; color:inherit; text-align:left; cursor:pointer; font:inherit; }
      :host([data-state='locked']) button { background:var(--coffer-tint); color:var(--coffer-accent); }
      button:hover,button:focus-visible { background:var(--coffer-hover); outline:2px solid var(--coffer-ring); outline-offset:-2px; }
      button:disabled { cursor:wait; opacity:.6; }
      .title,.username { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .title { font-weight:600; }
      .username { margin-top:2px; color:var(--coffer-muted); font-size:12px; }
    `;
    panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '1Warden · 此网站的账号');
    const heading = document.createElement('div');
    heading.className = 'heading';
    heading.textContent = '1Warden · 此网站的账号';
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

  function action(title: string, username: string | null, run: () => void): void {
    const button = document.createElement('button');
    button.type = 'button';
    const label = document.createElement('span');
    label.className = 'title';
    label.textContent = title;
    button.append(label);
    if (username !== null) {
      const detail = document.createElement('span');
      detail.className = 'username';
      detail.textContent = username || '未设置用户名';
      button.append(detail);
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
      const reply = await ext.runtime.sendMessage({ type: 'coffer:inline-fill', itemId }) as InlineReply;
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
    message('请在 1Warden 弹窗中解锁，再回到此处选择账号。');
    // Opening a native action popup can leave its Promise pending; observing
    // the completed unlock must not depend on that Promise settling.
    scheduleRefresh();
    // Send directly from this click; some browsers require a live user gesture.
    try {
      const reply = await ext.runtime.sendMessage({ type: 'coffer:inline-unlock' }) as InlineReply;
      if (!host || !awaitingUnlock) return;
      if (reply && 'error' in reply) message(reply.error);
    } catch {
      message('请点击浏览器工具栏中的 1Warden 图标解锁，然后回到此输入框选择账号。');
    }
  }

  async function refresh(quiet = false): Promise<void> {
    if (!host || busy) return;
    const version = ++request;
    if (!quiet) message('正在查找账号…');
    try {
      const reply = await ext.runtime.sendMessage({ type: 'coffer:inline-accounts' }) as InlineAccounts | { error: string };
      if (version !== request || !host) return;
      if (!reply || 'error' in reply) throw new Error(reply && 'error' in reply ? reply.error : '扩展没有响应，请重试');
      if (!reply.unlocked && quiet) { scheduleRefresh(); return; }
      const hadFocus = document.activeElement === host;
      choices?.replaceChildren();
      buttons = [];
      host.dataset['state'] = reply.unlocked ? 'accounts' : 'locked';
      if (!reply.unlocked) {
        message('解锁保险库以查看此网站的账号');
        action('解锁 1Warden', null, () => { void unlock(); });
      } else {
        awaitingUnlock = false;
        if (refreshTimer !== null) clearTimeout(refreshTimer);
        refreshTimer = null;
        message(reply.accounts.length ? '' : '此网站没有匹配的账号');
        for (const account of reply.accounts) action(account.title, account.username, () => { void choose(account.id); });
      }
      // Removing the focused unlock button fires focusout. Move focus into the
      // replacement choices before its dismissal check runs.
      if (hadFocus && buttons.length) focusButton(0);
      position();
    } catch (error) {
      if (version !== request || !host) return;
      awaitingUnlock = false;
      const hadFocus = document.activeElement === host;
      choices?.replaceChildren();
      buttons = [];
      host.dataset['state'] = 'error';
      message(errorText(error, '无法读取账号，请重试'));
      action('重试', null, () => { void refresh(); });
      if (hadFocus) focusButton(0);
      position();
    }
  }

  function eligible(target: EventTarget | null): target is HTMLInputElement {
    if (!(target instanceof HTMLInputElement) || target.disabled || target.readOnly) return false;
    const fields = readFields();
    const index = Array.from(document.querySelectorAll('input, textarea')).indexOf(target);
    const plan = classifyFields(fields);
    return index >= 0 && (index === plan.username || index === plan.password);
  }

  function show(event: Event): void {
    if (!event.isTrusted || restoringFocus || busy) return;
    if (!eligible(event.target)) return;
    if (host && anchor === event.target) return;
    close();
    anchor = event.target;
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
}
