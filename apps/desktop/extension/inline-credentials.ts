import type { CaptureNotice, GenerationTarget, GeneratorSettings } from './credential-protocol';
import type { CredentialObserver } from './credential-observer';
import { sameOriginDocument } from './credential-form';
import { ext } from './ext-api';

export function generatorSettings(target: Pick<GenerationTarget, 'minLength' | 'maxLength'>, settings?: GeneratorSettings): GeneratorSettings {
  return { length: Math.max(target.minLength, Math.min(target.maxLength, settings?.length ?? 20)),
    digits: settings?.digits ?? true, symbols: settings?.symbols ?? true };
}
export function noticeText(notice: Pick<CaptureNotice, 'url' | 'username' | 'action'>): { source: string; detail: string; description: string; action: string } {
  return { source: new URL(notice.url).host, detail: notice.username || '未设置用户名',
    description: notice.action === 'review' ? '检测到注册信息，请检查新账号后保存。'
      : notice.action === 'update' ? '检测到密码变更，请检查后更新账号。' : '登录或注册信息已就绪，请检查账号后保存。',
    action: notice.action === 'update' ? '检查并更新' : '检查并保存' };
}

const styles = `
  :host {font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;
    --paper:#fff;--ink:#202b3c;--muted:#43556e;--border:#bbcee8;--accent:#0667e8;--tint:#ecf3ff;}
  @media(prefers-color-scheme:dark){:host{--paper:#24344a;--ink:#f1f6ff;--muted:#c5d2e4;--border:#4b6382;--accent:#8ac0ff;--tint:#243f62;}}
  *{box-sizing:border-box}[hidden]{display:none!important}.panel{background:var(--paper);color:var(--ink);padding:14px;border:1px solid var(--border);
    border-radius:12px;box-shadow:0 8px 30px #26458029;overflow:auto;max-height:calc(100vh - 24px)}
  h2{font-size:14px;color:var(--accent);margin:0 0 8px}p{font-size:13px;color:var(--muted);margin:7px 0;overflow-wrap:anywhere}
  .masked{font:18px monospace;letter-spacing:1px;overflow:hidden;white-space:nowrap}.row{display:flex;gap:10px;align-items:center;margin:10px 0;flex-wrap:wrap}
  label{font-size:13px;display:flex;gap:6px;align-items:center}input[type=number]{width:66px;padding:5px;background:var(--paper);color:var(--ink);border:1px solid var(--border);border-radius:5px}
  button{font:inherit;color:var(--accent);background:var(--tint);border:0;border-radius:7px;padding:9px 11px;cursor:pointer}
  button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button:disabled{opacity:.55;cursor:wait}.secondary{background:transparent;color:var(--muted)}
  .status:empty{display:none}.source{font-weight:600;color:var(--ink)}
  .arrival{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
`;

interface Panel { host: HTMLDivElement; shadow: ShadowRoot; panel: HTMLDivElement }
function createPanel(kind: 'generator' | 'notice', title: string): Panel | null {
  if (!document.documentElement) return null;
  const host = document.createElement('div');
  host.dataset['onewardenCredentials'] = kind;
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;z-index:2147483647!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style'); style.textContent = styles;
  const panel = document.createElement('div'); panel.className = 'panel';
  panel.setAttribute('role', kind === 'generator' ? 'dialog' : 'region');
  panel.setAttribute('aria-label', title);
  const heading = document.createElement('h2'); heading.textContent = title;
  panel.append(heading); shadow.append(style, panel);
  document.documentElement.append(host);
  if (typeof host.showPopover === 'function') {
    host.popover = 'manual'; try { host.showPopover(); } catch { /* fixed fallback */ }
  }
  return { host, shadow, panel };
}
function paragraph(panel: HTMLElement, text: string, className = ''): HTMLParagraphElement {
  const el = document.createElement('p'); el.textContent = text; el.className = className; panel.append(el); return el;
}
function button(panel: HTMLElement, text: string, run: () => void, secondary = false): HTMLButtonElement {
  const el = document.createElement('button'); el.type = 'button'; el.textContent = text;
  if (secondary) el.className = 'secondary';
  el.addEventListener('click', event => { if (event.isTrusted) run(); }); panel.append(el); return el;
}
function toggle(panel: HTMLElement, text: string, checked: boolean): HTMLInputElement {
  const label = document.createElement('label'); const input = document.createElement('input');
  input.type = 'checkbox'; input.checked = checked; label.append(input, document.createTextNode(text)); panel.append(label); return input;
}

export interface InlineCredentials {
  prefersGenerator(field: HTMLInputElement): boolean;
  openGenerator(field: HTMLInputElement): Promise<void>;
  closeGenerator(): void;
  dispose(): void;
}

/** Only metadata enters these closed-shadow panels; generated password values never do. */
export function installInlineCredentials(observer: CredentialObserver): InlineCredentials {
  let generator: Panel | null = null;
  let notice: Panel | null = null;
  let noticeKey = '';
  let anchor: HTMLInputElement | null = null;
  let version = 0;
  let generated = false;
  let generationBusy = false;
  let openedUnlocked = false;
  let unlockPoll: ReturnType<typeof setTimeout> | null = null;
  let unlockTries = 0;
  let url = location.href;
  let disposed = false;
  let restoringFocus = false;
  const abort = new AbortController();
  const opts = { capture: true, signal: abort.signal };

  function closeGenerator(): void {
    version++; generator?.host.remove(); generator = null; anchor = null; generated = false; generationBusy = false;
    if (unlockPoll !== null) clearTimeout(unlockPoll); unlockPoll = null; unlockTries = 0;
  }
  function dismissGenerator(): void {
    const previous = anchor; closeGenerator();
    if (previous?.isConnected) {
      restoringFocus = true; previous.focus({ preventScroll: true }); restoringFocus = false;
    }
  }
  function prefersGenerator(field: HTMLInputElement): boolean {
    const group = observer.forms.group(field);
    return !!group && group.intent !== 'login' && (group.password === field || group.confirm === field);
  }
  function position(): void {
    if (!generator || !anchor) return;
    if (!anchor.isConnected || location.href !== url || !observer.forms.generationField(anchor)) { closeGenerator(); return; }
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(340, Math.max(280, innerWidth - 16));
    const height = generator.panel.getBoundingClientRect().height;
    generator.host.style.setProperty('width', `${Math.min(width, innerWidth - 16)}px`, 'important');
    generator.host.style.setProperty('left', `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`, 'important');
    const top = innerHeight - rect.bottom < height + 16 && rect.top > height + 8 ? rect.top - height - 6 : rect.bottom + 6;
    generator.host.style.setProperty('top', `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`, 'important');
  }
  function pollUnlock(): void {
    if (unlockPoll !== null) clearTimeout(unlockPoll);
    if (!generator || observer.status.unlocked || document.hidden || unlockTries >= 30) return;
    unlockPoll = setTimeout(() => { unlockPoll = null; unlockTries++; void observer.refresh().then(pollUnlock); }, 1000);
  }
  async function unlock(status: HTMLElement): Promise<void> {
    status.textContent = '请在 1Warden 弹窗中解锁，然后回到此输入框。'; unlockTries = 0; pollUnlock();
    try {
      const reply = await ext.runtime.sendMessage({ type: '1warden:inline-unlock' }) as { error?: string } | undefined;
      if (reply?.error && status.isConnected) status.textContent = reply.error;
    } catch { if (status.isConnected) status.textContent = '请点击浏览器工具栏中的 1Warden 图标解锁。'; }
  }
  async function openGenerator(field: HTMLInputElement): Promise<void> {
    if (disposed || !sameOriginDocument(window)) return;
    const group = observer.forms.group(field);
    // Picker's secondary action may be anchored to the username.
    const primary = observer.forms.generationField(field) ?? (group?.username === field ? group.password : null);
    if (!primary) return;
    if (generator && anchor === primary && openedUnlocked === observer.status.unlocked) return;
    closeGenerator(); anchor = primary; url = location.href;
    const request = version;
    const target = await observer.bridge.describe(observer.forms.index(primary));
    if (request !== version || !target || !primary.isConnected) return;
    generator = createPanel('generator', '1Warden · 生成密码');
    if (!generator) { anchor = null; return; }
    openedUnlocked = observer.status.unlocked;
    const currentPanel = generator;
    currentPanel.shadow.addEventListener('keydown', event => {
      if (event.isTrusted && (event as KeyboardEvent).key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); dismissGenerator();
      }
    });
    if (!observer.status.unlocked) {
      const status = paragraph(currentPanel.panel, '解锁保险库后生成并填充密码。', 'status'); status.setAttribute('role', 'status');
      button(currentPanel.panel, '解锁 1Warden', () => { void unlock(status); });
      position(); return;
    }
    if (target.minLength > target.maxLength) {
      paragraph(currentPanel.panel, '网站密码长度要求超出此处 8–64 位的简易生成器范围。');
      paragraph(currentPanel.panel, '请点击浏览器工具栏中的 1Warden 图标，打开完整密码生成器，按网站要求设置后填入。');
      button(currentPanel.panel, '关闭', dismissGenerator, true); position(); return;
    }
    const settings = generatorSettings(target);
    paragraph(currentPanel.panel, '••••••••••••••••••••', 'masked');
    paragraph(currentPanel.panel, '密码保存在保险库的生成历史中。设置仅在点击填充时生效。');
    const row = document.createElement('div'); row.className = 'row';
    const label = document.createElement('label'); label.textContent = '长度';
    const length = document.createElement('input'); length.type = 'number'; length.min = String(target.minLength); length.max = String(target.maxLength); length.value = String(settings.length);
    label.append(length); row.append(label);
    const digits = toggle(row, '数字', true); const symbols = toggle(row, '符号', true);
    currentPanel.panel.append(row);
    const replacementRow = document.createElement('div'); replacementRow.className = 'row'; replacementRow.hidden = !target.needsReplacement;
    const replace = toggle(replacementRow, '替换我已输入的内容', false); currentPanel.panel.append(replacementRow);
    const status = paragraph(currentPanel.panel, `将生成 ${settings.length} 位密码`, 'status'); status.setAttribute('role', 'status');
    const submit = button(currentPanel.panel, '生成并填充', () => { void generate(); });
    button(currentPanel.panel, '关闭', dismissGenerator, true);
    async function generate(): Promise<void> {
      if (!anchor || !generator || generator !== currentPanel || submit.disabled) return;
      const live = await observer.bridge.describe(observer.forms.index(anchor));
      if (!live || generator !== currentPanel) { status.textContent = '输入框已改变，请重新选择'; return; }
      if (live.needsReplacement && !replace.checked) {
        replacementRow.hidden = false; status.textContent = '输入框已有内容，请勾选确认替换后再填充。'; position(); return;
      }
      const selectedLength = Number(length.value);
      if (!Number.isInteger(selectedLength) || selectedLength < live.minLength || selectedLength > live.maxLength) {
        status.textContent = `请输入 ${live.minLength}–${live.maxLength} 之间的长度`; return;
      }
      const hadButtonFocus = currentPanel.shadow.activeElement === submit;
      generationBusy = true; submit.disabled = true; status.textContent = '正在生成并填充…';
      const result = await observer.generate(observer.forms.index(anchor), { length: selectedLength, digits: digits.checked, symbols: symbols.checked }, replace.checked);
      if (generator !== currentPanel) return;
      generationBusy = false; submit.disabled = false;
      if (hadButtonFocus && document.activeElement === document.body) submit.focus({ preventScroll: true });
      if (result.error) status.textContent = result.error;
      else {
        generated = true; replace.checked = false; replacementRow.hidden = true;
        status.textContent = '已填充。注册或改密后，请提交网页表单，再检查并保存账号。';
      }
      submit.textContent = generated ? '重新生成并填充' : '生成并填充'; position();
    }
    position();
  }

  function renderNotice(): void {
    const item = observer.status.notices[0];
    const key = item ? `${item.id}:${item.revision}` : '';
    if (notice?.host.isConnected && key === noticeKey && observer.status.unlocked && !document.hidden && sameOriginDocument(window)) return;
    notice?.host.remove(); notice = null; noticeKey = '';
    if (disposed || !sameOriginDocument(window) || !observer.status.unlocked || document.hidden) return;
    if (!item || new URL(item.url).origin !== location.origin) return;
    notice = createPanel('notice', '1Warden · 检查账号');
    if (!notice) return;
    noticeKey = key;
    const currentNotice = notice;
    notice.host.style.setProperty('right', '16px', 'important');
    notice.host.style.setProperty('bottom', '16px', 'important');
    notice.host.style.setProperty('width', 'min(340px, calc(100vw - 32px))', 'important');
    const text = noticeText(item);
    paragraph(notice.panel, text.source, 'source'); paragraph(notice.panel, text.detail); paragraph(notice.panel, text.description);
    const arrival = paragraph(notice.panel, '', 'arrival'); arrival.setAttribute('role', 'status');
    arrival.setAttribute('aria-live', 'polite'); arrival.setAttribute('aria-atomic', 'true');
    // Populate the already-mounted live region on the next task. Arrival must
    // be announced without moving focus out of the website's form.
    setTimeout(() => {
      if (!disposed && notice === currentNotice && currentNotice.host.isConnected) {
        arrival.textContent = `1Warden：${text.source}，${text.description}可${text.action}。`;
      }
    }, 0);
    const status = paragraph(notice.panel, '', 'status'); status.setAttribute('role', 'status');
    let busy = false;
    async function action(type: 'review' | 'snooze'): Promise<void> {
      if (busy) return; busy = true;
      const result = await observer.notice(item!.id, type);
      if (result.error && notice === currentNotice) { status.textContent = result.error; busy = false; }
    }
    const row = document.createElement('div'); row.className = 'row'; notice.panel.append(row);
    button(row, text.action, () => { void action('review'); }); button(row, '暂不', () => { void action('snooze'); }, true);
    notice.shadow.addEventListener('keydown', event => {
      if (event.isTrusted && (event as KeyboardEvent).key === 'Escape') { event.stopPropagation(); void action('snooze'); }
    });
  }

  const unsubscribe = observer.subscribe(() => {
    renderNotice();
    if (generator && anchor && openedUnlocked !== observer.status.unlocked) { const previous = anchor; closeGenerator(); void openGenerator(previous); }
  });
  const show = (event: Event) => {
    if (restoringFocus || !event.isTrusted || !(event.target instanceof HTMLInputElement) || !prefersGenerator(event.target)) return;
    void openGenerator(event.target);
  };
  document.addEventListener('focusin', show, opts); document.addEventListener('click', show, opts);
  document.addEventListener('pointerdown', event => {
    if (generator && event.target !== anchor && !event.composedPath().includes(generator.host)) closeGenerator();
  }, opts);
  document.addEventListener('focusout', () => { setTimeout(() => {
    if (!generationBusy && generator && document.hasFocus() && document.activeElement !== anchor && document.activeElement !== generator.host && unlockPoll === null) closeGenerator();
  }, 0); }, opts);
  document.addEventListener('keydown', event => {
    if (!event.isTrusted) return;
    if (generator && event.target === anchor && ((event.key === 'Tab' && !event.shiftKey) || event.key === 'ArrowDown')) {
      const first = generator.shadow.querySelector<HTMLElement>('input, button');
      if (first) { event.preventDefault(); first.focus({ preventScroll: true }); }
    } else if (event.key === 'Escape') {
      // Let the shadow listener restore the field when focus is inside the panel.
      if (generator && !event.composedPath().includes(generator.host)) { closeGenerator(); event.preventDefault(); }
      else if (!generator && notice && observer.status.notices[0]) void observer.notice(observer.status.notices[0].id, 'snooze');
    }
  }, opts);
  document.addEventListener('DOMContentLoaded', renderNotice, { signal: abort.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) closeGenerator(); renderNotice(); }, { signal: abort.signal });
  window.addEventListener('resize', position, { signal: abort.signal });
  window.addEventListener('scroll', position, opts);
  window.addEventListener('pagehide', () => { closeGenerator(); notice?.host.remove(); notice = null; }, { signal: abort.signal });
  return { prefersGenerator, openGenerator, closeGenerator, dispose: () => {
    disposed = true; abort.abort(); unsubscribe(); closeGenerator(); notice?.host.remove(); notice = null;
  } };
}
