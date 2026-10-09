import { SERVICE_BRANDS } from './service-brands/catalog';
import { SERVICE_ARTWORK } from './service-brands/artwork';
import { LOCAL_ASSETS } from './service-brands/local-assets';
import { OFFICIAL_ARTWORK } from './service-brands/overrides';

/** The catalogue and item renderer share this registry; counts cannot drift. */
export const BUILTIN_SERVICE_ICONS = SERVICE_BRANDS.map(brand => {
  const { id, domains } = brand;
  const official = OFFICIAL_ARTWORK[id];
  return {
    id, domains, ...SERVICE_ARTWORK[id],
    keywords: 'keywords' in brand ? brand.keywords : [],
    src: LOCAL_ASSETS[id] ?? null,
    source: official ? { name: `${official.name} 官方`, url: official.source }
      : { name: 'Simple Icons', url: `https://cdn.jsdelivr.net/npm/simple-icons@16.34.0/icons/${id}.svg` },
  };
});

const BY_DOMAIN = new Map(BUILTIN_SERVICE_ICONS.flatMap(brand =>
  brand.domains.map(domain => [domain as string, brand] as const)));

/** Input is a hostname, not a URL or item name. This is decoration, never trust. */
export function serviceBrandLogo(domain: string | null | undefined) {
  if (!domain) return null;
  let host = domain.toLowerCase().replace(/\.$/, '');
  if (host.length > 253 || !host.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;

  while (host.includes('.')) {
    const brand = BY_DOMAIN.get(host);
    if (brand) return brand;
    host = host.slice(host.indexOf('.') + 1);
  }
  return null;
}
