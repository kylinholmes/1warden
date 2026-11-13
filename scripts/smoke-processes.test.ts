import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { closeSmokeBrowser, launchSmokeBrowser, ownSmokeProcess, removeSmokeProfile, stopSmokeProcess } from './smoke-processes.mjs';

const children: ChildProcess[] = [];
const descendants: number[] = [];
const live = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
it('only removes a generated smoke profile inside the temporary directory', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'onewarden-smoke-cleanup-'));
  writeFileSync(join(profile, 'fixture.txt'), 'synthetic');
  await removeSmokeProfile(profile);
  expect(existsSync(profile)).toBe(false);
  await expect(removeSmokeProfile(tmpdir())).rejects.toThrow('disposable smoke profile boundary');
});

it.skipIf(process.platform !== 'win32')('waits for a transient Windows profile file lock to release', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'onewarden-smoke-locked-'));
  const file = join(profile, 'fixture.txt'); writeFileSync(file, 'synthetic');
  const escaped = file.replaceAll("'", "''");
  const locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$file=[IO.File]::Open('${escaped}',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); Write-Output 'locked'; Start-Sleep -Milliseconds 500; $file.Dispose()`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(locker);
  try {
    const [ready] = await once(locker.stdout!, 'data');
    expect(ready.toString().trim()).toBe('locked');
    expect(() => rmSync(file)).toThrow();
    await removeSmokeProfile(profile);
    expect(existsSync(profile)).toBe(false);
  } finally {
    stopSmokeProcess(locker);
    if (existsSync(profile)) await removeSmokeProfile(profile);
  }
});

it('opts explicitly requested Firefox automation into system access without changing the runner environment', async () => {
  const before = process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS;
  let launched: any;
  await launchSmokeBrowser({ launch: async (options: any) => { launched = options; return { process: () => null }; } },
    { browser: 'firefox', args: ['--remote-allow-system-access'], env: { SMOKE_FIXTURE: 'isolated' } });
  expect(launched.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS).toBe('1');
  expect(launched.env.SMOKE_FIXTURE).toBe('isolated');
  expect(process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS).toBe(before);
});

it.each([{ browser: 'chrome', args: ['--remote-allow-system-access'] }, { browser: 'firefox', args: [] }])(
  'does not add system access to browsers without an explicit Firefox opt-in: %j', async options => {
    let launched: any;
    await launchSmokeBrowser({ launch: async (value: any) => { launched = value; return { process: () => null }; } }, options);
    expect(launched).toBe(options);
    expect(launched.env).toBeUndefined();
  });

async function tree() {
  const child = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
    console.log(child.pid); setInterval(()=>{},1000);
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const [data] = await once(child.stdout!, 'data');
  const descendant = Number(data.toString().trim()); descendants.push(descendant);
  return { child, descendant };
}
afterEach(() => {
  for (const child of children.splice(0)) stopSmokeProcess(child);
  for (const pid of descendants.splice(0)) if (live(pid)) process.kill(pid, 'SIGKILL');
});

it('closes a healthy browser and terminates the owned process before returning', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true });
  children.push(child); await once(child, 'spawn');
  let closed = false;
  await closeSmokeBrowser({ process: () => ownSmokeProcess(child), close: async () => {
    closed = true;
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
  } }, 1000);
  expect(closed).toBe(true); expect(live(child.pid!)).toBe(false);
});

it.each(['rejected', 'hung'])('cleans a %s browser without leaving its owned process tree', async (mode) => {
  const { child, descendant } = await tree();
  let treeGoneBeforeClose = false;
  await closeSmokeBrowser({ process: () => ownSmokeProcess(child), close: () => {
    treeGoneBeforeClose = !live(child.pid!) && !live(descendant);
    return mode === 'hung' ? new Promise(() => {}) : Promise.reject(new Error('closed CDP transport'));
  } }, 50);
  expect(live(child.pid!)).toBe(false);
  if (process.platform === 'win32') { expect(live(descendant)).toBe(false); expect(treeGoneBeforeClose).toBe(true); }
});

it.each(['exit', 'SIGTERM'])('cleans registered native children on runner %s', async (mode) => {
  const runner = spawn(process.execPath, ['--input-type=module', '-e', `
    import {spawn} from 'node:child_process';
    import {ownSmokeProcess} from ${JSON.stringify(new URL('./smoke-processes.mjs', import.meta.url).href)};
    const child=ownSmokeProcess(spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}));
    console.log(child.pid);
    ${mode === 'exit' ? 'setTimeout(()=>process.exit(0),100);' : "setTimeout(()=>process.emit('SIGTERM'),100);"}
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(runner);
  const ended = once(runner, 'exit');
  const [data] = await once(runner.stdout!, 'data'); const pid = Number(data.toString().trim());
  await ended;
  for (let i = 0; i < 100 && live(pid); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(live(pid)).toBe(false);
});

it('disconnects attached native WebViews without treating them as an owned browser', async () => {
  let disconnected = false;
  await closeSmokeBrowser({ process: () => null, disconnect: () => { disconnected = true; } }, 50);
  expect(disconnected).toBe(true);
});
