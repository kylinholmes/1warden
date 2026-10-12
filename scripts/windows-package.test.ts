import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = JSON.parse(execFileSync('bun', ['scripts/ci-validate.ts', '--json'], { encoding: 'utf8', windowsHide: true }));
const step = workflow.jobs.windows.steps.find((entry: { name?: string }) => entry.name === 'Package Windows installer and portable executable');

describe('Windows release packaging', () => {
  it('selects the installer by the current version instead of every cached setup executable', () => {
    expect(step.run).toContain('1Warden_${env:APP_VERSION}_x64-setup.exe');
    expect(step.run).not.toContain("-Filter '*-setup.exe'");
  });

  for (const hasCurrent of [true, false]) {
    it.runIf(process.platform === 'win32')(hasCurrent
      ? 'packages only this version when the Cargo cache contains an older installer'
      : 'refuses to publish an old cached installer when the current build is missing', () => {
      const root = mkdtempSync(join(tmpdir(), '1warden-package-test-'));
      const target = join(root, 'target');
      const release = join(target, 'x86_64-pc-windows-msvc/release');
      const nsis = join(release, 'bundle/nsis');
      const output = join(root, 'artifacts/windows');
      try {
        mkdirSync(nsis, { recursive: true });
        writeFileSync(join(nsis, '1Warden_0.1.0_x64-setup.exe'), 'old fixture installer');
        if (hasCurrent) writeFileSync(join(nsis, '1Warden_0.2.1_x64-setup.exe'), 'current fixture installer');
        writeFileSync(join(release, '1warden.exe'), 'current fixture portable');
        const run = () => execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'\n${step.run}`], {
          windowsHide: true, encoding: 'utf8', stdio: 'pipe',
          env: { ...process.env, CARGO_TARGET_DIR: target, GITHUB_WORKSPACE: root, APP_VERSION: '0.2.1', ONEWARDEN_NATIVE_EXE: join(release, '1warden.exe') },
        });
        if (hasCurrent) {
          run();
          expect(readdirSync(output).sort()).toEqual(['1Warden-0.2.1-windows-x64-portable.exe', '1Warden-0.2.1-windows-x64-setup.exe', 'SHA256SUMS-windows.txt']);
          expect(readFileSync(join(output, '1Warden-0.2.1-windows-x64-setup.exe'), 'utf8')).toBe('current fixture installer');
          expect(readFileSync(join(output, '1Warden-0.2.1-windows-x64-portable.exe'), 'utf8')).toBe('current fixture portable');
          expect(readFileSync(join(output, 'SHA256SUMS-windows.txt'), 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
        } else {
          expect(run).toThrow();
          expect(existsSync(output)).toBe(false);
        }
        expect(readFileSync(join(nsis, '1Warden_0.1.0_x64-setup.exe'), 'utf8')).toBe('old fixture installer');
      } finally {
        // Only the exact disposable directory created above can be removed.
        if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup path');
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
