// Isolated, local-only design prototypes. No network, storage, clipboard or authentication calls.
const params = new URLSearchParams(location.search);
const variant = ['a', 'b', 'c'].includes(params.get('variant')) ? params.get('variant') : 'a';
const surface = params.get('surface') === 'quick' ? 'quick' : 'login';
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const app = document.querySelector('#app');
const accounts = [
  { name: '个人账户', email: 'alex@example.com', server: 'vault.example.com', initial: 'A' },
  { name: '工作账户', email: 'alex@company.example', server: 'work.example.com', initial: 'W' },
  { name: '家庭账户', email: 'family@example.com', server: 'family.example.com', initial: 'F' },
];
let current = 0;
let step = 'account';
let menu = false;
let busy = false;
let serverUrl = 'https://vault.vaultwarden.com';
let serverChoice = serverUrl;
let customServer = '';
const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const serverHost = () => { try { return new URL(serverUrl).host; } catch { return '自定义服务器'; } };
const providerName = () => ({ 'https://vault.vaultwarden.com': 'Vaultwarden.com', 'https://vault.bitwarden.com': 'Bitwarden（美国）', 'https://vault.bitwarden.eu': 'Bitwarden（欧洲）' })[serverUrl] ?? '自定义服务器';
const icons = {
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="m12 5-7 7 7 7M5 12h14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  pin: '<path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Zm4 12v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const brand = (small = false) => `<div class="brand ${small ? 'small' : ''}"><img src="./brand.png" alt="" width="32" height="32"/><span>1Warden</span></div>`;
const security = () => `<p class="security">${icon('lock', 16)}<span>主密码只在本地用于派生密钥，<br/>永不发送到服务器。</span></p>`;
const identity = (index, includeEmail = false) => `<div class="account-identity"><span class="avatar" aria-hidden="true">${accounts[index].initial}</span><span class="identity-text"><strong>${accounts[index].name}</strong>${includeEmail ? `<small class="email">${accounts[index].email}</small>` : ''}<small>${includeEmail ? accounts[index].server : accounts[index].email}</small></span></div>`;
const compactIdentity = index => `<div class="account-identity"><span class="avatar" aria-hidden="true">${accounts[index].initial}</span><span class="identity-text"><strong>${accounts[index].email}</strong><small>${accounts[index].server}</small></span></div>`;
const accountRows = (mode = 'select') => accounts.map((account, index) => `<button type="button" class="account-row" data-${mode}="${index}" aria-current="${current === index}" title="${account.email} · ${account.server}">${identity(index)}${current === index ? icon('check', 16) : icon('chevron', 16)}</button>`).join('');
const password = (id = 'password', label = '主密码') => `<div><label class="field-label" for="${id}">${label}</label><div class="input-shell"><input id="${id}" name="password" type="password" autocomplete="current-password" placeholder="输入主密码" required /><button type="button" class="icon-btn" data-eye="${id}" aria-label="显示主密码" aria-pressed="false">${icon('eye')}</button></div></div>`;
const email = () => '<div><label class="field-label" for="email">邮箱</label><input id="email" name="email" type="email" autocomplete="username" placeholder="name@example.com" required /></div>';
const primary = (text, name = '') => `<button class="primary" type="submit" ${name ? `data-action="${name}"` : ''}><span>${text}</span>${surface === 'login' ? icon('chevron', 16) : ''}</button>`;
const error = () => '<p class="error" id="form-error" role="alert"></p>';
const register = () => '<p class="register">还没有账户？<button type="button" class="link-btn" data-register>创建账户</button></p>';
const serverFields = () => `<div class="server-fields"><label><span class="field-label">服务器</span><select data-server>${[['https://vault.vaultwarden.com', 'Vaultwarden.com（社区托管）'], ['https://vault.bitwarden.com', 'Bitwarden（美国）'], ['https://vault.bitwarden.eu', 'Bitwarden（欧洲）'], ['custom', '自定义服务器']].map(([url, name]) => `<option value="${url}" ${serverChoice === url ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label data-custom ${serverChoice === 'custom' ? '' : 'hidden'}><span class="field-label">服务器地址</span><input type="url" value="${escapeHtml(customServer)}" placeholder="https://vault.example.com" autocomplete="url" aria-label="服务器地址" ${serverChoice === 'custom' ? 'required' : ''} /></label></div>`;
const server = () => `<details class="server-disclosure"><summary>${icon('globe', 18)}<span class="server-copy"><strong>服务器</strong><small data-server-label>${escapeHtml(serverHost())}</small></span><span>更改 ${icon('down', 14)}</span></summary>${serverFields()}</details>`;
const compactAccount = () => `<div class="compact-account"><button type="button" class="account-toggle" data-toggle-account aria-expanded="${menu}" title="${accounts[current].name} · ${accounts[current].email} · ${accounts[current].server}">${compactIdentity(current)}<span>切换 ${icon('down', 12)}</span></button><div class="account-menu" ${menu ? '' : 'hidden'}>${accountRows()}</div></div>`;
function loginA() {
  return `<main class="login-page"><header class="login-header">${brand()}</header><div class="login-body"><h1>登录你的保险库</h1><p class="sub">连接服务器，继续使用你的密码。</p>${server()}<form data-form="login"><div class="fields">${email()}${password()}</div>${error()}<div class="form-actions">${primary('登录')}</div></form>${register()}${security()}</div><footer class="login-footer">1Warden · 连接你的 Vaultwarden</footer></main>`;
}
function loginB() {
  const serverStep = step === 'server';
  const aside = `<aside class="guided-aside">${brand()}<div><h2>连接你的保险库</h2><p>先确认服务器，再登录账户。<br/>每一步，只做一件事。</p><div class="steps"><div class="step ${serverStep ? 'active' : ''}"><span class="step-marker">${serverStep ? '1' : icon('check', 14)}</span><span><strong>选择服务器</strong><small>确认保险库存放的位置</small></span></div><div class="step ${!serverStep ? 'active' : ''}"><span class="step-marker">2</span><span><strong>登录账户</strong><small>输入邮箱和主密码</small></span></div></div></div>${security()}</aside>`;
  const progress = `<div class="mobile-step">${serverStep ? '<strong>1 服务器</strong>' : '<span>1 服务器</span>'}${icon('chevron', 12)}${serverStep ? '<span>2 登录账户</span>' : '<strong>2 登录账户</strong>'}</div>`;
  const form = serverStep
    ? `<form data-form="server">${serverFields()}<div class="form-actions">${primary('继续')}</div></form>`
    : `<div class="server-summary server-identity">${icon('globe')}<span class="server-copy"><strong>${providerName()}</strong><small>${escapeHtml(serverHost())}</small></span><button class="link-btn" type="button" data-step="server">更改</button></div><form data-form="login"><div class="fields">${email()}${password()}</div>${error()}<div class="form-actions">${primary('登录')}</div></form>${register()}`;
  return `<main class="guided-page">${aside}<div class="mobile-brand">${brand()}</div><div class="guided-main"><div class="guided-form">${progress}<button class="link-btn text-back step-back" type="button" data-step="${serverStep ? 'account' : 'server'}">${icon('back', 15)}${serverStep ? '返回账户登录' : '返回服务器选择'}</button><h1>${serverStep ? '选择你的服务器' : '登录你的保险库'}</h1><p class="sub">${serverStep ? '使用托管服务，或连接自建 Vaultwarden。' : '使用这台服务器上的账户登录。'}</p>${form}<div class="mobile-brand" style="padding:28px 0 0">${security()}</div></div></div></main>`;
}
function loginC() {
  return `<main class="login-page account-login"><header class="login-header">${brand()}</header><div class="account-layout"><section class="account-picker" aria-label="已保存的账户"><h2>欢迎回来</h2><p>选择账户，继续使用保险库。</p>${accountRows()}<button type="button" class="link-btn text-back" data-new-account>${icon('plus', 16)}登录其他账户</button></section><section class="account-form"><h1>解锁保险库</h1><p class="sub">${accounts[current].server}</p>${identity(current, true)}<form data-form="unlock"><div class="fields">${password()}</div>${error()}<div class="form-actions">${primary('解锁')}</div></form>${security()}</section></div><footer class="login-footer">服务器地址和邮箱保存在本机，方便下次连接。</footer></main>`;
}
function quickShell(content, className = '') {
  return `<main class="quick-page"><header class="quick-head">${brand(true)}<div class="quick-tools"><button class="icon-btn" type="button" data-pin aria-label="固定窗口" aria-pressed="false">${icon('pin', 16)}</button><button class="icon-btn" type="button" data-close aria-label="关闭预览窗口">${icon('close', 17)}</button></div></header><section class="quick-main ${className}" aria-label="解锁保险库">${content}</section><footer class="quick-foot"><span>${icon('lock', 12)}<span data-foot>解锁后继续搜索</span></span><span><span class="optional-hint"><kbd>Enter</kbd> 解锁</span><kbd>Esc</kbd> 关闭</span></footer></main>`;
}
function quickA() {
  return quickShell(`<div class="quick-form"><h1>解锁保险库</h1><p class="sub">输入主密码，继续搜索。</p>${compactAccount()}<form data-form="unlock"><div class="fields">${password()}</div>${error()}<div class="form-actions">${primary('解锁并搜索')}</div></form></div>`);
}
function quickB() {
  return quickShell(`<aside class="quick-account-aside"><p>选择账户</p>${accountRows()}<button type="button" class="link-btn" data-new-account>登录其他账户</button></aside><div class="split-unlock"><div class="quick-form"><h1>解锁保险库</h1><p class="sub">解锁后即可搜索此账户。</p>${compactIdentity(current)}<div class="split-mobile-accounts">${compactAccount()}</div><form data-form="unlock"><div class="fields">${password()}</div>${error()}<div class="form-actions">${primary('解锁并搜索')}</div></form></div></div>`, 'quick-split');
}
function quickC() {
  return quickShell(`<h1>选择账户并解锁</h1><p class="sub">直接在账户下输入主密码。</p><div class="inline-accounts">${accounts.map((account, index) => `<section class="inline-account" ${index === current ? 'open' : ''}><button class="account-row" type="button" data-select="${index}" aria-expanded="${index === current}">${identity(index)}${icon(index === current ? 'down' : 'chevron', 15)}</button>${index === current ? `<form class="inline-form" data-form="unlock"><label class="field-label" for="inline-password">主密码 · ${account.server}</label><div class="inline-input-row"><div class="input-shell"><input id="inline-password" type="password" name="password" autocomplete="current-password" placeholder="输入主密码" required /><button type="button" class="icon-btn" data-eye="inline-password" aria-label="显示主密码" aria-pressed="false">${icon('eye')}</button></div>${primary('解锁')}</div>${error()}</form>` : ''}</section>`).join('')}</div>`, 'inline-quick');
}
function render(focus = false) {
  menu = menu && variant !== 'c';
  app.innerHTML = surface === 'login' ? ({ a: loginA, b: loginB, c: loginC })[variant]() : ({ a: quickA, b: quickB, c: quickC })[variant]();
  if (focus) app.querySelector('input[type="password"]')?.focus();
  bind();
}
function message(text) {
  const el = app.querySelector('.error');
  if (el) { el.textContent = text; app.querySelector('input[name="password"]')?.setAttribute('aria-invalid', 'true'); app.querySelector('input[name="password"]')?.setAttribute('aria-describedby', 'form-error'); }
}
function simpleResult(title, copy) {
  const section = `<div class="preview-result"><h2>${title}</h2><p class="sub">${copy}</p><button class="secondary-btn" data-reset type="button">返回设计预览</button></div>`;
  app.innerHTML = surface === 'quick' ? quickShell(section) : `<main class="login-page"><header class="login-header">${brand()}</header>${section}</main>`;
  bind();
}
function searchResult() {
  app.innerHTML = quickShell(`<div class="search-preview"><label>${icon('search')}<input aria-label="搜索保险库" placeholder="搜索保险库…" /></label><div class="result">${icon('lock')}<span>GitHub<small>${accounts[current].email}</small></span><span style="flex:0;font-size:12px">示例</span></div><p class="preview-note">解锁交互预览已完成，以上为虚构搜索结果。</p><button type="button" class="link-btn" data-reset>返回解锁预览</button></div>`, 'search-result');
  bind(); app.querySelector('input')?.focus();
}
function bind() {
  app.querySelectorAll('[data-eye]').forEach(button => button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.eye);
    const showing = input.type === 'password'; input.type = showing ? 'text' : 'password';
    button.setAttribute('aria-label', showing ? '隐藏主密码' : '显示主密码'); button.setAttribute('aria-pressed', String(showing)); input.focus();
  }));
  app.querySelectorAll('[data-select]').forEach(button => button.addEventListener('click', () => {
    current = Number(button.dataset.select); menu = false; render(true);
  }));
  app.querySelector('[data-toggle-account]')?.addEventListener('click', () => {
    menu = !menu; render(); app.querySelector(menu ? '.account-menu button' : '[data-toggle-account]')?.focus();
  });
  app.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => { step = button.dataset.step; render(); }));
  app.querySelector('[data-new-account]')?.addEventListener('click', () => {
    if (surface === 'login') { app.innerHTML = loginA(); bind(); app.querySelector('input[type="email"]')?.focus(); }
    else simpleResult('在主窗口登录', '这里演示登录入口；当前原型不会打开应用或连接服务器。');
  });
  app.querySelector('[data-server]')?.addEventListener('change', event => {
    const value = event.target.value;
    serverChoice = value; serverUrl = value === 'custom' ? customServer : value;
    const custom = app.querySelector('[data-custom]'); custom.hidden = value !== 'custom';
    custom.querySelector('input').required = value === 'custom';
    const label = app.querySelector('[data-server-label]');
    if (label) label.textContent = serverHost();
  });
  app.querySelector('[data-custom] input')?.addEventListener('input', event => {
    customServer = event.target.value; serverUrl = customServer;
    const label = app.querySelector('[data-server-label]'); if (label) label.textContent = serverHost();
  });
  app.querySelector('[data-pin]')?.addEventListener('click', event => {
    const button = event.currentTarget; const next = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(next)); button.setAttribute('aria-label', next ? '取消固定窗口' : '固定窗口');
    app.querySelector('[data-foot]').textContent = next ? '窗口已固定 · 仅演示' : '解锁后继续搜索';
  });
  app.querySelector('[data-close]')?.addEventListener('click', () => simpleResult('窗口已关闭', '这是独立的界面原型，可以随时返回。'));
  app.querySelector('[data-register]')?.addEventListener('click', () => simpleResult('创建账户入口', '正式方案将保留现有注册流程。当前仅预览登录与解锁。'));
  app.querySelector('[data-reset]')?.addEventListener('click', () => render());
  app.querySelector('form')?.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    if (event.currentTarget.dataset.form === 'server') { step = 'account'; render(); return; }
    const input = event.currentTarget.querySelector('input[name="password"]');
    if (!input) return;
    const accepted = input.value === 'preview'; input.value = '';
    busy = true; const button = event.currentTarget.querySelector('.primary'); const original = button.innerHTML; button.disabled = true; button.textContent = event.currentTarget.dataset.form === 'login' ? '正在登录…' : '正在解锁…';
    await new Promise(resolve => setTimeout(resolve, 450)); busy = false;
    if (!accepted) { button.disabled = false; button.innerHTML = original; message('主密码不正确。此原型请使用 preview 重试。'); input.focus(); button.scrollIntoView({ block: 'nearest' }); return; }
    if (surface === 'quick') searchResult(); else simpleResult('预览登录完成', '这是交互演示，没有连接服务器，也没有保存输入内容。');
  });
}
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || surface !== 'quick') return;
  if (menu) { menu = false; render(); app.querySelector('[data-toggle-account]')?.focus(); }
  else simpleResult('窗口已关闭', '这是独立的界面原型，可以随时返回。');
});
window.addEventListener('blur', () => app.querySelectorAll('input[name="password"]').forEach(input => { input.value = ''; }));
render();
