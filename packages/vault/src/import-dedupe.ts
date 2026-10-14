import {
  emptyBankAccount, emptyCard, emptyDriversLicense, emptyIdentity, emptyPassport, emptySshKey,
  type VaultFolder, type VaultItem,
} from './model';
import { isProfileItem } from './profile';
import type { StoredPasskey } from './passkey';

function fields(value: object | null | undefined, names: readonly string[]): unknown {
  if (!value) return null;
  const record = value as Record<string, unknown>;
  return names.map(name => record[name] ?? null);
}

function date(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

/** Match decryptPasskeys: empty optional strings disappear, and empty metadata uses native defaults. */
function passkey(credential: StoredPasskey): unknown {
  return [credential.credentialId, credential.keyType || 'public-key', credential.keyAlgorithm || 'ECDSA',
    credential.keyCurve || 'P-256', credential.keyValue, credential.rpId || '', credential.rpName || null,
    credential.userHandle || null, credential.userName || null, credential.userDisplayName || null,
    credential.counter || '0', credential.discoverable || 'true', date(credential.creationDate || '')];
}

/** Owner-memory only: explicit supported content, never server IDs or preservation metadata. */
function content(item: VaultItem, folderName: string | null): string {
  const login = item.type === 'login' ? item.login : null;
  return JSON.stringify({
    type: item.type, name: item.name, notes: item.notes, folderName, favorite: item.favorite,
    reprompt: item.reprompt, archived: !!item.archivedAt,
    login: login ? {
      username: login.username, password: login.password, totp: login.totp,
      autofillOnPageLoad: login.autofillOnPageLoad ?? null,
      passwordRevisionDate: date(login.passwordRevisionDate),
      uris: login.uris.map(uri => [uri.uri, uri.match ?? null]),
      fido2Credentials: login.fido2Credentials.map(passkey),
    } : null,
    card: item.type === 'card' ? fields(item.card, Object.keys(emptyCard())) : null,
    identity: item.type === 'identity' ? fields(item.identity, Object.keys(emptyIdentity())) : null,
    sshKey: item.type === 'sshKey' ? fields(item.sshKey, Object.keys(emptySshKey())) : null,
    bankAccount: item.type === 'bankAccount' ? fields(item.bankAccount, Object.keys(emptyBankAccount())) : null,
    driversLicense: item.type === 'driversLicense' ? fields(item.driversLicense, Object.keys(emptyDriversLicense())) : null,
    passport: item.type === 'passport' ? fields(item.passport, Object.keys(emptyPassport())) : null,
    secureNote: item.type === 'secureNote' ? item.secureNote?.type ?? 0 : null,
    customFields: item.customFields.map(field => [field.name, field.value, field.type, field.linkedId ?? null]),
    passwordHistory: item.passwordHistory.map(entry => [entry.password, date(entry.lastUsedDate)]),
  });
}

/** Consume each pre-existing copy once; newly created source duplicates remain deliberate. */
export function createImportMatcher(items: readonly VaultItem[], folders: readonly VaultFolder[]):
  (item: VaultItem, folderName: string | null) => boolean {
  const eligible = items.filter(item => !item.deletedAt && !item.preservation?.source.organizationId && !isProfileItem(item));
  if (eligible.some(item => item.nameFailed || item.notesFailed || item.preservation?.failures.length)
    || folders.some(folder => folder.nameFailed)) {
    throw new Error('目标保险库包含无法完整读取的数据，未执行导入，请同步或修复后重试');
  }
  const folderNameById = new Map(folders.map(folder => [folder.id, folder.name]));
  const remaining = new Map<string, number>();
  for (const item of eligible) {
    // A missing folder name cannot be safely compared with an unfiled record.
    if (item.folderId !== null && !folderNameById.has(item.folderId)) {
      throw new Error('目标保险库的文件夹信息不完整，未执行导入，请同步后重试');
    }
    const key = content(item, item.folderId === null ? null : folderNameById.get(item.folderId)!);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return (item, folderName) => {
    const key = content(item, folderName);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) remaining.delete(key);
    else remaining.set(key, count - 1);
    return true;
  };
}
