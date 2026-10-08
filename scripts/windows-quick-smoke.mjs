/** Runs ONLY its own onewarden process and disposable WebView profile; never logs secrets.
 * Clipboard test is opt-in: ONEWARDEN_TEST_CLIPBOARD=1 replaces clipboard with synthetic text.
 */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectNativeBrowser } from './native-smoke-startup.mjs';
const { default: puppeteer } = await import(pathToFileURL(process.env.ONEWARDEN_PUPPETEER).href);
const output = await mkdtemp(join(tmpdir(), '1warden-native-quick-'));
const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = server.address().port; await new Promise(resolve => server.close(resolve));
await mkdir(join(output, 'profile'));
const app = spawn(process.env.ONEWARDEN_NATIVE_EXE, [], { windowsHide: true, env: { ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: join(output, 'profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` } });
const probePath = resolve('scripts/windows-quick-probe.ps1');
function probe(action, expected = '') {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', probePath, '-AppProcessId', String(app.pid), '-Action', action, '-Expected', expected], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw Error(result.stderr || result.stdout); return result.stdout.trim();
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, pass) { if (!pass) throw Error(name); console.log(`PASS ${name}`); }
let browser, main, quick, original;
const invoke = (page, command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const visible = () => invoke(quick, 'plugin:window|is_visible', { label: 'quick' });
async function until(fn, label) { for (let i=0;i<80;i++) { if(await fn())return; await pause(100); } throw Error(label); }
try {
  browser = await connectNativeBrowser({ app, connect: options => puppeteer.connect(options), browserURL: `http://127.0.0.1:${port}` });
  await until(async()=> { const pages=await browser.pages(); main=pages.find(p=>p.url()==='http://tauri.localhost/'); quick=pages.find(p=>p.url().endsWith('/quick.html')); return main&&quick; }, 'missing pages');
  await main.waitForSelector('main'); await quick.waitForSelector('[aria-label="固定快速搜索"]');
  original = await invoke(main, 'quick_status');
  if (process.env.ONEWARDEN_QUICK_CASE === 'clipboard-only') {
    console.log('clipboard-only start:', new Date().toISOString());
    await invoke(main,'clipboard_copy',{value:'1warden-qa-isolated-expiry'});
    console.log('clipboard initial metadata:', probe('clipboard-meta'));
    for (let second=0;second<35;second++) {
      await pause(1000);
      if(app.exitCode!==null)throw Error(`Process exited at ${second+1}s, code ${app.exitCode}`);
    }
    check('isolated clipboard timer does not exit the application', true);
    console.log('clipboard after expiry:', probe('clipboard-meta'), 'still same synthetic text:', probe('clipboard-equals','1warden-qa-isolated-expiry'));
    check('isolated clipboard timer clears its own text',probe('clipboard-equals','')==='true');
  } else {
  const enabled = await invoke(main, 'quick_set_enabled', { enabled:true });
  check('native hotkey registers', enabled.enabled && !enabled.shortcutError);
  probe('hotkey'); await until(visible, 'quick did not open').catch(async error => {
    console.log('quick native state:', await invoke(quick,'quick_window_state')); throw error;
  });
  await until(()=>invoke(quick,'plugin:window|is_focused',{label:'quick'}),'quick not focused');
  check('quick opens unfixed', !(await invoke(quick,'quick_window_state')).pinned);
  const background = await quick.evaluate(()=>['html','body','#root'].map(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor));
  check('all three root layers are transparent', background.every(value=>value==='rgba(0, 0, 0, 0)'));
  await quick.screenshot({ path:join(output,'quick-transparent.png'), omitBackground:true });
  await quick.keyboard.press('Escape'); await until(async()=>!await visible(),'locked quick did not close on Escape');
  check('Escape works even with a disabled locked search field',true);
  probe('hotkey'); await until(visible,'reopen after locked Escape failed');
  probe('focus-main'); await until(async()=>!await visible(),'blur did not hide quick');
  check('native focus loss hides quick',true);
  probe('hotkey'); await until(visible,'reopen failed');
  await quick.click('[aria-label="固定快速搜索"]');
  await until(async()=>(await invoke(quick,'quick_window_state')).pinned,'pin did not apply');
  probe('focus-main'); await pause(300);
  check('pinned quick survives native focus loss',await visible());
  await quick.keyboard.press('Escape'); await until(async()=>!await visible(),'Escape did not hide pinned quick');
  probe('hotkey'); await until(visible,'second reopen failed');
  check('reopening resets temporary pin',!(await invoke(quick,'quick_window_state')).pinned);
  await invoke(main,'quick_set_enabled',{enabled:false});
  check('disable immediately hides quick',!await visible());
  probe('hotkey-message'); await pause(200); check('disabled entry cannot reopen quick',!await visible());
  await invoke(main,'quick_set_enabled',{enabled:true}); probe('hotkey'); await until(visible,'reenabling failed');
  check('reenabling re-registers shortcut',true);
  for (const command of ['quick_set_enabled','clipboard_copy']) {
    check(`${command} rejects quick caller`,await invoke(quick,command,{enabled:false,value:'synthetic'}).then(()=>false,()=>true));
  }
  if(process.env.ONEWARDEN_TEST_CLIPBOARD==='1') {
    const first='1warden-qa-unfocused-密🔑';
    check('main document is unfocused before copy',!await main.evaluate(()=>document.hasFocus()));
    await invoke(main,'clipboard_copy',{value:first});
    check('native clipboard copied exact Unicode from unfocused main',probe('clipboard-equals',first)==='true');
    await invoke(quick,'quick_hide');
    console.log('waiting for clipboard expiry:', new Date().toISOString());
    // Check both sides of the real 30-second expiry without exposing clipboard contents.
    await pause(31000); check('clipboard expiry works with quick hidden',probe('clipboard-equals','')==='true');
    await invoke(main,'clipboard_copy',{value:'1warden-qa-expiry-guard'});
    probe('clipboard-later'); await pause(31000);
    check('expiry preserves a later copy',probe('clipboard-equals','1warden-qa-later-copy')==='true');
  }
  console.log(`PASS native quick; artifacts ${output}`);
  }
} finally {
  if(main && original) await invoke(main,'quick_set_enabled',{enabled:original.enabled}).catch(()=>{});
  if(browser) await browser.disconnect(); if(app.exitCode===null)app.kill();
}
