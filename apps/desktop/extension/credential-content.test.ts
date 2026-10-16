import { describe, expect, it } from 'vitest';
import content from './content.ts?raw';
import manifest from './public/manifest.json?raw';

describe('credential observer content wiring', () => {
  it('installs the isolated observer at document_start and retires legacy submitted messages', () => {
    const scripts = JSON.parse(manifest).content_scripts as { js: string[]; run_at: string; world?: string; all_frames: boolean }[];
    const entry = scripts.find(script => script.js.includes('content.js'))!;
    expect(entry.run_at).toBe('document_start');
    expect(entry.world ?? 'ISOLATED').toBe('ISOLATED');
    expect(entry.all_frames).toBe(true);
    expect(content).toContain('installCredentialObserver()');
    expect(content).toContain('installInlineCredentials(');
    expect(content).not.toContain("type: '1warden:submitted'");
  });
});
