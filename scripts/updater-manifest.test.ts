import { describe, expect, it } from 'vitest';
import { createUpdaterManifest } from './updater-manifest';

const input = {
  version: '0.1.0', repository: 'kylinholmes/1warden',
  signature: 'dGVzdC1zaWduYXR1cmU=', pubDate: '2026-10-08T00:00:00.000Z',
};

describe('public updater manifest', () => {
  it('points Apple Silicon at its versioned signed archive, with the signature text', () => {
    const result = createUpdaterManifest(input);
    expect(result.version).toBe('0.1.0');
    expect(Object.keys(result.platforms)).toEqual(['darwin-aarch64']);
    expect(result.platforms['darwin-aarch64']).toEqual({
      url: 'https://github.com/kylinholmes/1warden/releases/download/v0.1.0/1Warden-0.1.0-macos-apple-silicon.app.tar.gz',
      signature: input.signature,
    });
    expect(result.pub_date).toBe(input.pubDate);
  });

  it('rejects empty or invalid signature data instead of publishing a broken updater', () => {
    for (const signature of ['', '  ', 'unsigned archive']) {
      expect(() => createUpdaterManifest({ ...input, signature })).toThrow(/signature/i);
    }
  });

  it('rejects versions or repository values that could change the archive URL', () => {
    for (const version of ['v0.1.0', '../0.1.0', '0.1.0?token=x']) {
      expect(() => createUpdaterManifest({ ...input, version })).toThrow(/version/i);
    }
    for (const repository of ['https://example.com/update', 'owner/repo/../other', 'owner']) {
      expect(() => createUpdaterManifest({ ...input, repository })).toThrow(/repository/i);
    }
  });
});
