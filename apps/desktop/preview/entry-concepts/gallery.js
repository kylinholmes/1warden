const params = new URLSearchParams(location.search);
let variant = ['a', 'b', 'c'].includes(params.get('variant')) ? params.get('variant') : 'a';
let surface = params.get('surface') === 'quick' ? 'quick' : 'login';
let theme = 'light';
const notes = {
  a: { login: '首次登录：服务器身份始终可见；地址和测速不再与主密码争夺注意力。', quick: '高频解锁：以主密码为中心，账户用紧凑行展示，切换时展开列表。' },
  b: { login: '首次登录：先选服务器，再输入邮箱和密码。当前展示第 2 步，可返回体验第 1 步。', quick: '多账户解锁：宽窗口左侧选择账户、右侧输入；窄窗口折叠为账户切换行。' },
  c: { login: '回访用户：展示已保存的账户与解锁入口；首次使用时点击“登录其他账户”进入完整表单。', quick: '账户优先：选择哪一行，就在那一行下展开主密码，不经过独立的头像页面。' },
};
const tradeoffs = {
  a: 'A 适合日常高频使用。表单位置稳定、操作最直接；切换账户需要展开一次列表。',
  b: 'B 适合初次连接和多服务器用户。步骤更清晰；首次登录多一次“继续”，小窗口的宽窄布局有明显区别。',
  c: 'C 适合长期使用多个账户。账户始终是主线；登录预览依赖已保存账户，首次使用需要回到完整表单。',
};
function fit() {
  const quick = surface === 'quick';
  for (const kind of ['desktop', 'mobile']) {
    const iframe = document.getElementById(kind);
    const box = document.getElementById(`${kind}-space`);
    const width = kind === 'desktop' ? quick ? 620 : 960 : quick ? 360 : 390;
    const height = kind === 'desktop' ? quick ? 400 : 720 : quick ? 400 : 760;
    const scale = Math.min(1, box.parentElement.clientWidth / width);
    box.style.width = `${width * scale}px`; box.style.height = `${height * scale}px`;
    iframe.style.width = `${width}px`; iframe.style.height = `${height}px`; iframe.style.transform = `scale(${scale})`;
    document.getElementById(`${kind}-size`).textContent = `${width} × ${height}`;
  }
}
function update() {
  const url = `./concept.html?variant=${variant}&surface=${surface}&theme=${theme}`;
  for (const kind of ['desktop', 'mobile']) { document.getElementById(kind).src = url; document.getElementById(kind).title = `${kind === 'desktop' ? '桌面' : '窄屏'}${surface === 'quick' ? '快捷解锁' : '登录'}预览 ${variant.toUpperCase()}`; }
  document.getElementById('open').href = url;
  document.getElementById('scenario').textContent = notes[variant][surface];
  document.getElementById('tradeoff').textContent = tradeoffs[variant];
  document.getElementById('desktop-label').textContent = surface === 'quick' ? '快捷小窗口' : '桌面';
  document.getElementById('mobile-label').textContent = surface === 'quick' ? '窄窗口' : '移动端';
  document.querySelectorAll('[data-variant]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.variant === variant)));
  document.querySelectorAll('[data-surface]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.surface === surface)));
  fit();
}
document.querySelectorAll('[data-variant]').forEach(button => button.addEventListener('click', () => { variant = button.dataset.variant; update(); }));
document.querySelectorAll('[data-surface]').forEach(button => button.addEventListener('click', () => { surface = button.dataset.surface; update(); }));
document.getElementById('theme').addEventListener('click', event => { theme = theme === 'light' ? 'dark' : 'light'; event.currentTarget.setAttribute('aria-pressed', String(theme === 'dark')); event.currentTarget.textContent = theme === 'dark' ? '浅色预览' : '深色预览'; update(); });
new ResizeObserver(fit).observe(document.querySelector('.preview-stage'));
update();
