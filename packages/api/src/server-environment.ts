export interface ServerEndpoints {
  api: string;
  identity: string;
  notifications: string;
  cloudRegion: 'US' | 'EU' | null;
}

/** Only the two known HTTPS web-vault roots use Bitwarden's separate services.
 * Custom servers, including subpath installs, always stay on their own origin.
 * Source: bitwarden/clients default-environment.service.ts, RegionConfigs. */
export function serverEnvironment(serverUrl: string): ServerEndpoints {
  const base = serverUrl.replace(/\/+$/, '');
  let normalized = base;
  try { normalized = new URL(base).href.replace(/\/+$/, ''); } catch { /* Input validation belongs to the caller. */ }
  const cloud = /^https:\/\/vault\.bitwarden\.(com|eu)$/.exec(normalized)?.[1];
  if (cloud) return {
    api: `https://api.bitwarden.${cloud}`,
    identity: `https://identity.bitwarden.${cloud}`,
    notifications: `https://notifications.bitwarden.${cloud}`,
    cloudRegion: cloud === 'eu' ? 'EU' : 'US',
  };
  return { api: `${base}/api`, identity: `${base}/identity`, notifications: `${base}/notifications`, cloudRegion: null };
}
