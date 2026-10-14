import {
  emptyBankAccount, emptyCard, emptyDriversLicense, emptyIdentity, emptyPassport, emptySshKey,
  type VaultFolder, type VaultItem,
} from './model';
import { isProfileItem } from './profile';
import { encryptJsonExport } from './import-encrypted';

export type ExportFormat = 'encrypted-json' | 'json' | 'csv';
export interface VaultExport {
  bytes: Uint8Array;
  filename: string;
  itemCount: number;
  folderCount: number;
  warnings: string[];
}
export interface VaultExportOptions {
  items: readonly VaultItem[];
  folders: readonly VaultFolder[];
  format: ExportFormat;
  password?: string;
}

const PASSKEY_KEYS = ['credentialId', 'keyType', 'keyAlgorithm', 'keyCurve', 'keyValue', 'rpId', 'rpName',
  'userHandle', 'userName', 'userDisplayName', 'counter', 'discoverable', 'creationDate'] as const;
const BLOCK_KEYS = {
  card: Object.keys(emptyCard()), identity: Object.keys(emptyIdentity()), sshKey: Object.keys(emptySshKey()),
  bankAccount: Object.keys(emptyBankAccount()), driversLicense: Object.keys(emptyDriversLicense()),
  passport: Object.keys(emptyPassport()), secureNote: ['type'],
};
const KNOWN_SOURCE_KEYS = new Set(['id', 'object', 'type', 'name', 'notes', 'folderId', 'favorite', 'reprompt',
  'creationDate', 'revisionDate', 'deletedDate', 'archivedDate', 'key', 'organizationId', 'collectionIds',
  'login', ...Object.keys(BLOCK_KEYS), 'fields', 'passwordHistory', 'attachments', 'permissions', 'edit',
  'viewPassword', 'organizationUseTotp', 'encryptedFor', 'lastKnownRevisionDate']);

/** Select fields explicitly: a domain object may contain opaque preservation state. */
function pick(value: object, keys: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

function hasUnmodeledFields(item: VaultItem): boolean {
  const source = item.preservation?.source;
  if (!source) return false;
  const extra = (value: unknown, known: readonly string[]): boolean => value !== null && typeof value === 'object'
    && Object.keys(value).some(key => !known.includes(key));
  const rows = (value: unknown, known: readonly string[]): boolean => Array.isArray(value) && value.some(row => extra(row, known));
  if (extra(source, [...KNOWN_SOURCE_KEYS])) return true;
  for (const name of Object.keys(BLOCK_KEYS) as Array<keyof typeof BLOCK_KEYS>) {
    if (extra(source[name], BLOCK_KEYS[name])) return true;
  }
  return extra(source.login, ['username', 'password', 'totp', 'autofillOnPageLoad', 'passwordRevisionDate', 'uris', 'fido2Credentials'])
    || rows(source.login?.uris, ['uri', 'match', 'uriChecksum'])
    || rows(source.login?.fido2Credentials, PASSKEY_KEYS)
    || rows(source.fields, ['name', 'value', 'type', 'linkedId'])
    || rows(source.passwordHistory, ['password', 'lastUsedDate']);
}

function jsonItem(item: VaultItem): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: item.id, organizationId: null, folderId: item.folderId, type: item.rawType,
    name: item.name, notes: item.notes, favorite: item.favorite, reprompt: item.reprompt,
    creationDate: item.createdAt, revisionDate: item.updatedAt, deletedDate: null, archivedDate: item.archivedAt,
    fields: item.customFields.map(field => pick(field, ['name', 'value', 'type', 'linkedId'])),
    passwordHistory: item.passwordHistory.map(entry => pick(entry, ['password', 'lastUsedDate'])),
  };
  if (item.login) result['login'] = {
    ...pick(item.login, ['username', 'password', 'totp', 'autofillOnPageLoad', 'passwordRevisionDate']),
    uris: item.login.uris.map(uri => pick(uri, ['uri', 'match'])),
    fido2Credentials: item.login.fido2Credentials.map(credential => pick(credential, PASSKEY_KEYS)),
  };
  for (const name of Object.keys(BLOCK_KEYS) as Array<keyof typeof BLOCK_KEYS>) {
    const value = item[name];
    if (value) result[name] = pick(value, BLOCK_KEYS[name]);
  }
  return result;
}

function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function createVaultExport(options: VaultExportOptions): Promise<VaultExport> {
  const { format, password, folders } = options;
  if (!['encrypted-json', 'json', 'csv'].includes(format)) throw new Error('不支持的导出格式');
  const warnings: string[] = [];
  const eligible = options.items.filter(item => !item.deletedAt && !isProfileItem(item)
    && !item.preservation?.source.organizationId);
  const orgCount = options.items.filter(item => !item.deletedAt && item.preservation?.source.organizationId).length;
  if (orgCount) warnings.push(`已排除 ${orgCount} 条组织条目；本次仅导出个人保险库。`);
  const unreadable = eligible.filter(item => item.nameFailed || item.notesFailed || item.preservation?.failures.length);
  if (unreadable.length) throw new Error(`${unreadable.length} 条记录无法完整读取或解密，已阻止导出，请先同步或修复这些记录`);
  if (folders.some(folder => folder.nameFailed)) throw new Error('存在无法读取的文件夹，已阻止导出，请先同步或修复');
  if (eligible.some(item => item.type === 'unknown' || item.customFields.some(field => field.unsupportedType !== undefined))) {
    throw new Error('存在未知条目或不支持的自定义字段类型，无法完整导出，请使用兼容客户端导出');
  }
  const attachments = eligible.reduce((count, item) => count + item.attachments.length, 0);
  if (attachments) warnings.push(`未导出 ${attachments} 个附件文件，请另外下载保存。`);
  if (eligible.some(hasUnmodeledFields)) {
    warnings.push('部分记录含有当前版本未支持的未知字段；这些字段未导出，请同时保留原客户端备份。');
  }
  let content: string;
  let exported = eligible;
  let folderCount = folders.length;
  if (format === 'csv') {
    exported = eligible.filter(item => item.type === 'login' || item.type === 'secureNote');
    const excluded = eligible.length - exported.length;
    warnings.push(`CSV 仅支持登录和安全笔记；已排除 ${excluded} 条其他类型记录。`);
    warnings.push('CSV 不保留通行密钥、密码历史、日期、归档状态、自动填充设置、网址匹配方式及自定义字段的类型和关联关系。');
    warnings.push('CSV 的自定义字段使用换行分隔；字段内的换行或冒号可能无法准确还原。');
    const byId = new Map(folders.map(folder => [folder.id, folder.name]));
    folderCount = new Set(exported.map(item => item.folderId).filter(id => id && byId.has(id))).size;
    const rows: Array<Array<string | number | null>> = [
      ['folder', 'favorite', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp'],
      ...exported.map(item => [item.folderId ? byId.get(item.folderId) ?? '' : '', item.favorite ? '1' : '',
        item.type === 'login' ? 'login' : 'note', item.name, item.notes,
        item.customFields.map(field => `${field.name}: ${field.value}`).join('\n'), item.reprompt,
        item.login?.uris.map(uri => csvCell(uri.uri)).join(',') ?? '', item.login?.username ?? '',
        item.login?.password ?? '', item.login?.totp ?? '']),
    ];
    content = rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  } else {
    content = JSON.stringify({ encrypted: false,
      folders: folders.map(folder => ({ id: folder.id, name: folder.name })), items: eligible.map(jsonItem),
    }, null, 2);
    if (format === 'encrypted-json') content = await encryptJsonExport(content, password ?? '');
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return { bytes: new TextEncoder().encode(content),
    filename: `1warden_${format === 'encrypted-json' ? 'encrypted_' : ''}export_${stamp}.${format === 'csv' ? 'csv' : 'json'}`,
    itemCount: exported.length, folderCount, warnings };
}
