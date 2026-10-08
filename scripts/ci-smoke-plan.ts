/** Declarative smoke suites; no application/browser side effects when imported by unit tests. */
export interface SmokeStep { name: string; runtime: 'bun' | 'node'; args: string[]; timeoutMs: number; build?: boolean }
export type SmokeSuite = 'ui' | 'extensions' | 'native' | 'all';
const build = (name: string, args: string[]): SmokeStep => ({ name, runtime: 'bun', args, build: true, timeoutMs: 300_000 });
const smoke = (name: string, script: string, args: string[] = [], runtime: 'bun' | 'node' = 'bun'): SmokeStep =>
  ({ name, runtime, args: [`scripts/${script}`, ...args], timeoutMs: 300_000 });

export function smokePlan(suite: SmokeSuite): SmokeStep[] {
  const ui = [
    build('build-preview-desktop', ['run', '--cwd', 'apps/desktop', 'preview:build']),
    build('build-preview-mobile', ['run', '--cwd', 'apps/desktop', 'preview:mobile:build']),
    build('build-preview-extension', ['run', '--cwd', 'apps/desktop', 'preview:extension:build']),
    smoke('layout', 'layout-smoke.ts'),
    smoke('navigation', 'navigation-header-smoke.ts'),
    smoke('motion', 'panel-motion-smoke.ts'),
    smoke('appearance', 'appearance-smoke.ts'),
    smoke('account-menu', 'profile-account-menu-smoke.ts'),
    smoke('zustand', 'zustand-state-smoke.ts'),
  ];
  const extensions = [
    build('build-extensions', ['run', 'build:extension-firefox']),
    smoke('edge-extension', 'browser-smoke.ts', ['edge']),
    smoke('firefox-extension', 'browser-smoke.ts', ['firefox']),
    smoke('connection', 'connection-smoke.ts', ['edge']),
    smoke('profile', 'profile-smoke.ts', ['edge']),
    smoke('account-details', 'account-details-smoke.ts'),
  ];
  if (suite === 'ui') return ui;
  if (suite === 'extensions') return extensions;
  if (suite === 'all') return [...ui, ...extensions];
  return [
    // Native account-details also opens a second, isolated Edge client to test sync.
    build('build-native-companion-extension', ['run', 'build:extension']),
    smoke('native-quick', 'windows-quick-smoke.mjs', [], 'node'),
    smoke('native-account-details', 'account-details-smoke.ts', ['--native']),
  ];
}

/** No inherited switch may redirect synthetic CI fixtures or enable the real clipboard. */
export function smokeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...source, ONEWARDEN_TEST_CLIPBOARD: '0', ONEWARDEN_SMOKE_CLIPBOARD: '0', ONEWARDEN_SMOKE_ATTACHMENTS: '0' };
  delete result.ONEWARDEN_PROFILE_REAL_URL;
  delete result.ONEWARDEN_QUICK_CASE;
  delete result.WEBVIEW2_USER_DATA_FOLDER;
  delete result.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  return result;
}

/** Reports only: never publish browser profiles, storage, databases, or generated fixture bundles. */
export function isSmokeEvidence(name: string): boolean {
  return name === 'report.json' || /^[a-z0-9][a-z0-9._-]*\.png$/i.test(name);
}
