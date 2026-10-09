import { cipherTypeToItemType, type VaultItem } from './model';
import { isProfileItem } from './profile';

export type OrganizationReason = 'checkedContentMatches' | 'sameUsernameAndHost';
/** Display findings only. Never return credentials, notes, comparison keys or drafts. */
export interface OrganizationReport {
  total: number;
  checked: number;
  skipped: number;
  duplicates: { kind: 'identical' | 'similar'; itemIds: string[]; reason: OrganizationReason }[];
  missingUrls: string[];
  missingUsernames: string[];
  lowInformationNames: string[];
  unfiled: string[];
}

const DEFAULT_NAMES = new Set(['untitled', 'untitled item', 'new item', 'new login', 'login', '未命名', '无标题', '新条目', '新建登录', '登录']);
const SOURCE_KEYS = new Set(['id', 'object', 'type', 'name', 'notes', 'folderId', 'favorite', 'reprompt', 'organizationId', 'key',
  'creationDate', 'revisionDate', 'deletedDate', 'archivedDate', 'edit', 'viewPassword', 'permissions', 'login', 'card',
  'identity', 'secureNote', 'sshKey', 'bankAccount', 'driversLicense', 'passport', 'fields', 'passwordHistory', 'attachments',
  'collectionIds', 'organizationUseTotp']);
const LOGIN_KEYS = new Set(['username', 'password', 'passwordRevisionDate', 'totp', 'uris', 'autofillOnPageLoad', 'fido2Credentials', 'uri']);
const URI_KEYS = new Set(['uri', 'match', 'uriChecksum']);
const FIELD_KEYS = new Set(['name', 'value', 'type', 'linkedId']);
const knownKeys = (value: object, keys: ReadonlySet<string>) => Object.keys(value).every(key => keys.has(key));

/** Unknown preserved server fields can carry content that the decoded model omits. */
function hasOpaqueContent(item: VaultItem): boolean {
  const source = item.preservation?.source;
  if (!source) return false;
  return !knownKeys(source, SOURCE_KEYS) || source.organizationId != null || Boolean(source.collectionIds?.length)
    || (source.login != null && !knownKeys(source.login, LOGIN_KEYS))
    // The decoder does not consume the legacy URI alias. Only an alias identical
    // to the server's first encrypted URI is known to be redundant.
    || (source.login?.uri != null && source.login.uri !== source.login.uris?.[0]?.uri)
    || Boolean(source.login?.uris?.some(uri => !knownKeys(uri, URI_KEYS)))
    || Boolean(source.fields?.some(field => !knownKeys(field, FIELD_KEYS)));
}

/** Only plain, fully decoded login records receive the stronger equivalence label. */
function checkedContentKey(item: VaultItem): string | null {
  const login = item.login;
  if (item.type !== 'login' || item.rawType !== 1 || !login || item.attachments.length || item.passwordHistory.length
    || login.fido2Credentials.length || item.customFields.some(field => field.unsupportedType !== undefined)
    || item.card || item.identity || item.secureNote || item.sshKey || item.bankAccount || item.driversLicense || item.passport
    || hasOpaqueContent(item)) return null;
  // These temporary keys stay inside the owner process and are discarded after
  // the scan. Credentials are compared exactly; no trimming or case folding.
  return JSON.stringify([item.type, item.rawType, item.name, item.notes, item.folderId, item.favorite, item.reprompt,
    login.username, login.password, login.totp, login.passwordRevisionDate,
    Object.hasOwn(login, 'autofillOnPageLoad'), login.autofillOnPageLoad,
    login.uris.map(uri => [uri.uri, uri.match]),
    item.customFields.map(field => [field.name, field.value, field.type, field.linkedId])]);
}

/** Preserve the complete host and non-default port; never collapse subdomains. */
function hostOf(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.host.toLowerCase().replace(/\.(?=:|$)/, '');
  } catch { return null; }
}

/** Local, read-only organization hints, scoped to active readable records. */
export function buildOrganizationReport(items: readonly VaultItem[]): OrganizationReport {
  const active = items.filter(item => !item.deletedAt && !item.archivedAt && !isProfileItem(item));
  const readable = active.filter(item => !item.nameFailed && !item.notesFailed && !item.preservation?.failures.length
    && !item.attachments.some(attachment => attachment.failed)
    && item.type !== 'unknown' && cipherTypeToItemType(item.rawType) === item.type);
  const report: OrganizationReport = { total: active.length, checked: readable.length, skipped: active.length - readable.length,
    duplicates: [], missingUrls: [], missingUsernames: [], lowInformationNames: [], unfiled: [] };
  const parent = new Map<string, string>();
  const exactKeys = new Map<string, string | null>();
  const byContent = new Map<string, string>();
  const byAccountHost = new Map<string, string>();
  function root(id: string): string {
    const next = parent.get(id)!;
    if (next === id) return id;
    const result = root(next); parent.set(id, result); return result;
  }
  function link(id: string, other: string) { parent.set(root(id), root(other)); }
  for (const item of readable) {
    parent.set(item.id, item.id);
    if (item.folderId === null) report.unfiled.push(item.id);
    const name = item.name.trim().toLowerCase();
    if (!name || DEFAULT_NAMES.has(name)) report.lowInformationNames.push(item.id);
    if (item.type === 'login') {
      // A preserved legacy alias is not decoded into uris. Its ciphertext may
      // contain a real address, so absence cannot be established from this view.
      const legacyUri = item.preservation?.source.login?.uri;
      if (!item.login?.uris.some(uri => uri.uri.trim()) && (legacyUri == null || legacyUri === '')) report.missingUrls.push(item.id);
      if (!item.login?.username?.trim()) report.missingUsernames.push(item.id);
    }
    const exact = checkedContentKey(item);
    exactKeys.set(item.id, exact);
    if (exact !== null) {
      const prior = byContent.get(exact);
      if (prior) link(item.id, prior); else byContent.set(exact, item.id);
    }
    if (item.type !== 'login' || !item.login?.username?.trim()) continue;
    for (const uri of item.login.uris) {
      // Regex patterns are not site addresses even when they look like one.
      if (uri.match === 4) continue;
      const host = hostOf(uri.uri);
      if (host === null) continue;
      const key = JSON.stringify([item.type, item.login.username, host]);
      const prior = byAccountHost.get(key);
      if (prior) link(item.id, prior); else byAccountHost.set(key, item.id);
    }
  }
  const groups = new Map<string, string[]>();
  for (const item of readable) {
    const id = root(item.id);
    const members = groups.get(id) ?? []; members.push(item.id); groups.set(id, members);
  }
  for (const itemIds of groups.values()) {
    if (itemIds.length < 2) continue;
    const key = exactKeys.get(itemIds[0]!);
    const identical = key != null && itemIds.every(id => exactKeys.get(id) === key);
    // A component containing both equal and different records is shown once as
    // suspected duplicates, instead of repeating an equal subset in two lists.
    report.duplicates.push({ kind: identical ? 'identical' : 'similar', itemIds,
      reason: identical ? 'checkedContentMatches' : 'sameUsernameAndHost' });
  }
  return report;
}
