import type { VaultFolder, VaultItem } from './model';
import { isProfileItem } from './profile';

export interface OrganizationMergeRequest { baseId: string; sourceIds: string[] }
export interface OrganizationMergeCommit { token: string; choices: Record<string, string> }
export interface OrganizationMergeReveal { token: string; fieldKey: 'password' | 'totp'; itemId: string }
export interface OrganizationMergePreview {
  token: string;
  baseId: string;
  itemIds: string[];
  items: { id: string; name: string; updatedAt: string }[];
  fields: { key: string; label: string; secret: boolean;
    options: { itemId: string; value: string | null }[]; selectedItemId: string | null }[];
  additions: { label: string; count: number }[];
  blockers: string[];
  warnings: string[];
}
export interface OrganizationMergeResult {
  baseId: string;
  saved: true;
  trashedIds: string[];
  retainedSources: { id: string; reason: string }[];
}

const SOURCE_KEYS = new Set(['id', 'object', 'type', 'name', 'notes', 'folderId', 'favorite', 'reprompt', 'organizationId', 'key',
  'creationDate', 'revisionDate', 'deletedDate', 'archivedDate', 'edit', 'viewPassword', 'permissions', 'login', 'card',
  'identity', 'secureNote', 'sshKey', 'bankAccount', 'driversLicense', 'passport', 'fields', 'passwordHistory', 'attachments',
  'collectionIds', 'organizationUseTotp']);
const LOGIN_KEYS = new Set(['username', 'password', 'passwordRevisionDate', 'totp', 'uris', 'autofillOnPageLoad', 'fido2Credentials', 'uri']);
const known = (value: object, keys: ReadonlySet<string>) => Object.keys(value).every(key => keys.has(key));
const present = (value: unknown) => value !== null && value !== undefined && value !== '';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const scalarFields = [
  { key: 'name', label: '名称', secret: false, value: (i: VaultItem) => i.name },
  { key: 'username', label: '用户名', secret: false, value: (i: VaultItem) => i.login?.username },
  { key: 'password', label: '密码', secret: true, value: (i: VaultItem) => i.login?.password },
  { key: 'totp', label: '验证码密钥', secret: true, value: (i: VaultItem) => i.login?.totp },
  { key: 'folderId', label: '文件夹', secret: false, value: (i: VaultItem) => i.folderId },
  { key: 'autofillOnPageLoad', label: '页面加载时自动填充', secret: false, value: (i: VaultItem) => i.login?.autofillOnPageLoad },
] as const;

/** Reject data whose exact semantics cannot be transferred to another cipher. */
export function mergeBlockers(items: readonly VaultItem[]): string[] {
  const reasons = new Set<string>();
  for (const item of items) {
    const source = item.preservation?.source;
    if (item.type !== 'login' || item.rawType !== 1 || !item.login || isProfileItem(item)
      || item.card || item.identity || item.secureNote || item.sshKey || item.bankAccount || item.driversLicense || item.passport) {
      reasons.add('目前仅支持普通登录条目合并');
    }
    if (item.deletedAt || item.archivedAt) reasons.add('回收站或已归档条目不能合并');
    if (item.nameFailed || item.notesFailed || item.preservation?.failures.length) reasons.add('存在无法完整读取的字段，请先修复后再合并');
    if (item.reprompt !== 0) reasons.add('需要再次验证主密码的条目暂不支持合并');
    if (item.attachments.length) reasons.add('包含附件，暂不能安全转移附件；请先单独处理');
    if (item.login?.fido2Credentials.length) reasons.add('包含通行密钥，暂不支持安全转移；请保留原条目');
    if (item.customFields.some(field => field.unsupportedType !== undefined)) reasons.add('包含暂不支持的自定义字段类型');
    if (item.customFields.some(field => field.type === 3)) reasons.add('包含关联字段，请先将其转为普通字段后合并，避免关联目标变化');
    if (source) {
      if (source.organizationId != null || source.collectionIds?.length) reasons.add('组织或共享条目暂不支持合并');
      if (source.edit === false || source.viewPassword === false) reasons.add('没有完整读取或编辑这些条目的权限');
      if (!known(source, SOURCE_KEYS)
        || (source.login != null && !known(source.login, LOGIN_KEYS))
        || (source.login?.uri != null && source.login.uri !== source.login.uris?.[0]?.uri)
        || source.login?.uris?.some(row => !known(row, new Set(['uri', 'match', 'uriChecksum'])))
        || source.fields?.some(row => !known(row, new Set(['name', 'value', 'type', 'linkedId'])))
        || source.passwordHistory?.some(row => !known(row, new Set(['password', 'lastUsedDate'])))) {
        reasons.add('包含未识别的服务器字段，已阻止合并以免丢失数据');
      }
    }
  }
  return [...reasons];
}

function unique<T>(values: readonly T[], key: (value: T) => unknown): T[] {
  const seen = new Set<string>();
  return values.filter(value => { const identity = JSON.stringify(key(value)); if (seen.has(identity)) return false; seen.add(identity); return true; });
}

function candidates(items: readonly VaultItem[], field: (typeof scalarFields)[number]) {
  return unique(items.filter(item => present(field.value(item))), item => field.value(item));
}

/** Safe projection: never returns passwords, seeds, notes, custom values or hashes. */
export function previewOrganizationMerge(items: readonly VaultItem[], folders: readonly VaultFolder[], token: string): OrganizationMergePreview {
  const base = items[0]!;
  const fields: OrganizationMergePreview['fields'] = [];
  for (const field of scalarFields) {
    const choices = candidates(items, field);
    if (choices.length < 2) continue;
    fields.push({ key: field.key, label: field.label, secret: field.secret, selectedItemId: null,
      options: choices.map(item => ({ itemId: item.id, value: field.secret ? null : field.key === 'folderId'
        ? (folders.find(folder => folder.id === item.folderId)?.name ?? '未知文件夹')
        : typeof field.value(item) === 'boolean' ? (field.value(item) ? '开启' : '关闭') : String(field.value(item)) })) });
  }
  return {
    token, baseId: base.id, itemIds: items.map(item => item.id), items: items.map(item => ({ id: item.id, name: item.name, updatedAt: item.updatedAt })), fields,
    additions: [
      { label: '网址（去重后）', count: unique(items.flatMap(i => i.login?.uris ?? []), row => [row.uri, row.match]).length },
      { label: '自定义字段（保留不同值）', count: unique(items.flatMap(i => i.customFields), row => [row.name, row.type, row.value, row.linkedId]).length },
      { label: '备注段落（保留不同内容）', count: unique(items.filter(i => present(i.notes)), i => i.notes).length },
      { label: '原密码历史', count: unique(items.flatMap(i => i.passwordHistory), row => [row.password, row.lastUsedDate]).length },
      ...scalarFields.filter(field => !present(field.value(base)) && candidates(items, field).length === 1)
        .map(field => ({ label: `自动补全${field.label}`, count: 1 })),
    ], blockers: mergeBlockers(items), warnings: [
      '冲突字段必须选择采用哪一条；其他密码会保存在历史密码中，其他名称、用户名和验证码密钥会保存在隐藏自定义字段中。',
      '网址、自定义字段、备注和密码历史会合并保留；收藏状态只要任一条开启就保留。',
      '主条目保存并核验成功后，其他来源才会移到回收站。服务端不支持跨条目事务；检测到变化的来源会保留，处理结果不确定时会提示同步核查。',
    ],
  };
}

/** Owner-only reconstruction. UI supplies source IDs, never authoritative values. */
export function mergeOrganizationItems(items: readonly VaultItem[], choices: Record<string, string>): VaultItem {
  const blockers = mergeBlockers(items);
  if (blockers.length) throw new Error(blockers.join('；'));
  const base = items[0]!;
  const merged = structuredClone(base);
  const selected = new Map<string, unknown>();
  for (const field of scalarFields) {
    const options = candidates(items, field);
    if (options.length > 1 && !options.some(item => item.id === choices[field.key])) throw new Error(`请选择「${field.label}」的来源`);
    const chosen = options.length > 1 ? options.find(item => item.id === choices[field.key])! : options[0];
    selected.set(field.key, chosen ? field.value(chosen) : field.value(base));
  }
  const conflicts = scalarFields.filter(field => candidates(items, field).length > 1).map(field => field.key as string);
  if (Object.keys(choices).some(key => !conflicts.includes(key))) throw new Error('合并选择无效，请重新预览');
  merged.name = selected.get('name') as string;
  merged.folderId = selected.get('folderId') as string | null;
  merged.favorite = items.some(item => item.favorite);
  merged.login = { ...merged.login!, username: selected.get('username') as string | null,
    password: selected.get('password') as string | null, totp: selected.get('totp') as string | null,
    uris: unique(items.flatMap(i => i.login!.uris.map(row => i.id === base.id ? row : { uri: row.uri, match: row.match })), row => [row.uri, row.match]) };
  const autofill = selected.get('autofillOnPageLoad');
  if (autofill !== undefined) merged.login.autofillOnPageLoad = autofill as boolean | null;
  merged.notes = unique(items.filter(i => present(i.notes)), i => i.notes).map(item => item.notes).join('\n\n---\n\n') || null;
  merged.customFields = unique(items.flatMap(i => i.customFields.map(row => i.id === base.id ? row
    : { name: row.name, value: row.value, type: row.type, linkedId: row.linkedId })), row => [row.name, row.value, row.type, row.linkedId]);
  merged.passwordHistory = unique(items.flatMap(i => i.passwordHistory.map(row => i.id === base.id ? row
    : { password: row.password, lastUsedDate: row.lastUsedDate })), row => [row.password, row.lastUsedDate]);
  for (const field of scalarFields.filter(f => ['name', 'username', 'totp', 'password'].includes(f.key))) {
    for (const item of candidates(items, field)) {
      const value = field.value(item);
      if (same(value, selected.get(field.key))) continue;
      if (field.key === 'password') {
        if (!merged.passwordHistory.some(row => row.password === value)) merged.passwordHistory.push({ password: String(value),
          lastUsedDate: item.login!.passwordRevisionDate || item.updatedAt });
      } else {
        merged.customFields.push({ name: `合并保留 · ${field.label} · ${item.name}`, value: String(value), type: 1, linkedId: null });
      }
    }
  }
  return merged;
}
