#!/usr/bin/env bun
/** CI/local entrypoint for existing synthetic browser and owned-process WebView smoke suites. */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isSmokeEvidence, smokeEnvironment, smokePlan, type SmokeStep, type SmokeSuite } from './ci-smoke-plan';

const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2).filter(arg => arg !== '--');
const suite = (args.find(arg => !arg.startsWith('--')) ?? 'all') as SmokeSuite;
if (!['ui', 'extensions', 'native', 'all'].includes(suite)) throw new Error('Suite must be ui, extensions, native, or all');
const skipBuild = args.includes('--skip-build');
const selected = args.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
const plan = smokePlan(suite).filter(step => (!step.build || !skipBuild) && (!selected || step.build || selected.includes(step.name)));
if (selected?.some(name => !smokePlan(suite).some(step => !step.build && step.name === name))) throw new Error('Unknown --only test name');
const output = resolve(process.env.ONEWARDEN_CI_OUTPUT ?? mkdtempSync(join(tmpdir(), `1warden-ci-${suite}-`)));
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), `1warden-ci-work-${suite}-`));
const env = smokeEnvironment(process.env);
env.ONEWARDEN_PUPPETEER = Bun.resolveSync('puppeteer-core', root);

function findExecutable(variable: string, candidates: string[], required: boolean) {
  const path = env[variable] ?? candidates.find(candidate => existsSync(candidate));
  if (required && (!path || !existsSync(path))) throw new Error(`Set ${variable} to an installed browser executable`);
  if (path) env[variable] = path;
}
const windows = process.platform === 'win32';
const programFiles = process.env.ProgramFiles ?? 'C:/Program Files';
findExecutable('ONEWARDEN_EDGE', windows ? [
  join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
] : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/microsoft-edge'], true);
findExecutable('ONEWARDEN_FIREFOX', windows ? [join(programFiles, 'Mozilla Firefox/firefox.exe')]
  : ['/Applications/Firefox.app/Contents/MacOS/firefox', '/usr/bin/firefox'], plan.some(step => step.name === 'firefox-extension'));
if (suite === 'native') {
  if (!windows) throw new Error('The native suite requires Windows');
  if (!env.ONEWARDEN_NATIVE_EXE || !existsSync(env.ONEWARDEN_NATIVE_EXE)) throw new Error('Set ONEWARDEN_NATIVE_EXE to the built 1warden.exe');
  // WebView profiles are already isolated by each script. Isolate native config/cache too.
  env.APPDATA = join(scratch, 'native-config/roaming');
  env.LOCALAPPDATA = join(scratch, 'native-config/local');
  mkdirSync(env.APPDATA, { recursive: true }); mkdirSync(env.LOCALAPPDATA, { recursive: true });
}

const results: Array<{ name: string; code: number; timedOut: boolean; elapsedMs: number }> = [];
writeFileSync(join(output, 'environment.json'), JSON.stringify({ suite, platform: process.platform, arch: process.arch,
  bun: Bun.version, node: spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim(),
  puppeteer: JSON.parse(await Bun.file(join(dirname(env.ONEWARDEN_PUPPETEER), '../../package.json')).text()).version,
  edge: env.ONEWARDEN_EDGE, firefox: env.ONEWARDEN_FIREFOX, nativeExe: suite === 'native' ? env.ONEWARDEN_NATIVE_EXE : undefined,
  clipboardTests: false, realServer: false }, null, 2));

async function run(step: SmokeStep) {
  const stepDir = join(output, step.name); mkdirSync(stepDir, { recursive: true });
  const stepTemp = join(scratch, step.name); mkdirSync(stepTemp, { recursive: true });
  const evidence = join(stepDir, 'evidence'); mkdirSync(evidence, { recursive: true });
  const childEnv = { ...env, TEMP: stepTemp, TMP: stepTemp, TMPDIR: stepTemp,
    ONEWARDEN_LAYOUT_OUTPUT: evidence, ONEWARDEN_HEADER_OUTPUT: evidence,
    ONEWARDEN_PANEL_OUTPUT: evidence, ONEWARDEN_APPEARANCE_OUTPUT: evidence,
    ONEWARDEN_ACCOUNT_MENU_OUTPUT: evidence, ONEWARDEN_SMOKE_OUT: evidence,
    ONEWARDEN_PANEL_PREVIEW: join(root, 'apps/desktop/dist-preview'),
  };
  console.log(`\n::group::${step.name}`);
  const start = Date.now(); const log = createWriteStream(join(stepDir, 'run.log'));
  const executable = step.runtime === 'bun' ? process.execPath : 'node';
  const child = spawn(executable, step.args, { cwd: root, env: childEnv, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true; log.write(`\nTimed out after ${step.timeoutMs} ms\n`);
    // Target only this spawned test and its descendants, never processes by image name.
    if (windows && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  }, step.timeoutMs);
  const code = await new Promise<number>(done => {
    child.on('error', error => { log.write(`${error.stack}\n`); done(1); });
    child.on('close', value => done(value ?? 1));
  });
  clearTimeout(timer); await new Promise<void>(done => log.end(done));
  // Existing scripts put screenshots/reports directly in a mkdtemp child. Do not traverse profiles.
  for (const entry of readdirSync(stepTemp, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(stepTemp, entry.name), { withFileTypes: true })) {
      if (!file.isFile() || !isSmokeEvidence(file.name)) continue;
      const destination = join(evidence, entry.name); mkdirSync(destination, { recursive: true });
      copyFileSync(join(stepTemp, entry.name, file.name), join(destination, file.name));
    }
  }
  results.push({ name: step.name, code: timedOut ? 1 : code, timedOut, elapsedMs: Date.now() - start });
  console.log(`::endgroup::\n${step.name}: ${code === 0 && !timedOut ? 'PASS' : 'FAIL'}`);
  return code === 0 && !timedOut;
}

try {
  for (const step of plan) {
    const passed = await run(step);
    if (!passed && step.build) break; // Never test stale bundles after a failed build.
  }
} finally {
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ suite, results }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## ${suite} smoke results\n\n| Check | Result | Seconds |\n| --- | --- | --- |\n${results.map(result =>
      `| ${result.name} | ${result.code === 0 ? 'PASS' : 'FAIL'} | ${(result.elapsedMs / 1000).toFixed(1)} |`).join('\n')}\n`);
  // Only delete our mkdtemp workspace after resolving and validating its boundary.
  const actual = realpathSync(scratch), tempRoot = realpathSync(tmpdir()), inside = relative(tempRoot, actual);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !inside.startsWith('1warden-ci-work-')) throw new Error('Refusing to clean an unexpected temporary path');
  try { rmSync(actual, { recursive: true, force: true }); }
  catch { console.warn(`Some owned temporary files are still in use: ${scratch}`); }
}
console.log(`CI evidence: ${output}`);
if (results.length !== plan.length || results.some(result => result.code !== 0)) process.exitCode = 1;
