import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateWorkflow } from './ci-policy';
import { isSmokeEvidence, smokeEnvironment, smokePlan } from './ci-smoke-plan';

const workflow = JSON.parse(execFileSync('bun', ['scripts/ci-validate.ts', '--json'], { encoding: 'utf8', windowsHide: true }));
const copy = () => structuredClone(workflow);
describe('CI workflow and synthetic smoke contract', () => {
  it('parses the actual YAML and enforces least privilege, pinned actions and required validation', () => {
    expect(validateWorkflow(workflow)).toEqual([]);
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(packageJson.devDependencies['puppeteer-core']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson.scripts['test:windows']).toContain('ci-smoke.ts native');
  });
  it('rejects floating actions, retained credentials, and privileged PR triggers', () => {
    const value = copy();
    value.jobs.ui.steps[0].uses = 'actions/checkout@main';
    value.jobs.ui.steps[0].with['persist-credentials'] = true;
    value.on.pull_request_target = {};
    expect(validateWorkflow(value).join('\n')).toMatch(/commit SHAs/);
    expect(validateWorkflow(value).join('\n')).toMatch(/persist credentials/);
    expect(validateWorkflow(value).join('\n')).toMatch(/pull_request_target/);
  });
  it('rejects smoke secrets, lost failure evidence, or a release bypass of UI checks', () => {
    const value = copy();
    value.jobs.ui.env = { TOKEN: '${{ secrets.EXAMPLE }}', OUTPUT: '${{ runner.temp }}' };
    value.jobs.windows.steps.find((step: any) => step.with?.name === 'test-results-native-windows').if = 'success()';
    value.jobs.release.needs = ['check'];
    const failures = validateWorkflow(value).join('\n');
    expect(failures).toMatch(/cannot reference secrets/);
    expect(failures).toMatch(/runner context belongs in step env/);
    expect(failures).toMatch(/even on failures/);
    expect(failures).toMatch(/wait for automated UI/);
  });
  it('keeps browser-engine, width, navigation, native focus and real CSP regressions in the suites', () => {
    const all = smokePlan('all').map(step => step.name);
    expect(all).toEqual(expect.arrayContaining(['layout', 'navigation', 'motion', 'appearance', 'edge-extension', 'firefox-extension', 'connection', 'profile', 'account-details']));
    expect(smokePlan('native').map(step => step.name)).toEqual(['build-native-companion-extension', 'native-quick', 'native-account-details']);
    expect(smokePlan('all').every(step => step.timeoutMs > 0 && step.timeoutMs <= 300_000)).toBe(true);
  });
  it('blocks inherited real-vault/clipboard switches and WebView profile reuse', () => {
    const actual = smokeEnvironment({ ONEWARDEN_PROFILE_REAL_URL: 'http://127.0.0.1:8080', ONEWARDEN_TEST_CLIPBOARD: '1',
      ONEWARDEN_SMOKE_CLIPBOARD: '1', ONEWARDEN_QUICK_CASE: 'clipboard-only', WEBVIEW2_USER_DATA_FOLDER: 'real-profile', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: 'reused-port' });
    expect(actual.ONEWARDEN_PROFILE_REAL_URL).toBeUndefined();
    expect(actual.ONEWARDEN_TEST_CLIPBOARD).toBe('0');
    expect(actual.ONEWARDEN_SMOKE_CLIPBOARD).toBe('0');
    expect(actual.ONEWARDEN_QUICK_CASE).toBeUndefined();
    expect(actual.WEBVIEW2_USER_DATA_FOLDER).toBeUndefined();
    expect(actual.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).toBeUndefined();
  });
  it('selectively retains evidence, never browser profile state or databases', () => {
    expect(isSmokeEvidence('report.json')).toBe(true);
    expect(isSmokeEvidence('failure-0.png')).toBe(true);
    for (const file of ['Cookies', 'Local State', 'Preferences', 'storage.sqlite', 'manifest.json', 'bundle.js', '../profile.png']) expect(isSmokeEvidence(file)).toBe(false);
  });
});
