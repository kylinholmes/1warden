/** Shared build transformation; no filesystem access so it can be tested in isolation. */
export function firefoxManifest(source: Record<string, unknown>): Record<string, unknown> {
  if (source['manifest_version'] !== 3) throw new Error('Expected a Manifest V3 extension');
  const background = source['background'] as { service_worker?: unknown; type?: unknown } | undefined;
  if (typeof background?.service_worker !== 'string' || !background.service_worker) {
    throw new Error('Missing background.service_worker in Chrome build');
  }
  const result = structuredClone(source);
  result['background'] = { scripts: [background.service_worker], type: background.type ?? 'classic' };
  delete result['minimum_chrome_version'];
  result['permissions'] = ((source['permissions'] ?? []) as string[]).filter((p) => p !== 'offscreen');
  result['browser_specific_settings'] = {
    gecko: { id: 'coffer@coffer.app', strict_min_version: '128.0' },
  };
  return result;
}
