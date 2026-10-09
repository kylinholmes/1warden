import { lockedAccount } from './account-target';
import {
  buildProfileItem, isProfileItem, parseProfile, selectProfileItem, profileRevision,
  buildPreferencesItem, buildDeviceItem, parseProfileSettings, validatePreferences,
  buildReport, buildOrganizationReport, checkBreaches, hasTotp, IMPORT_FORMATS, parseImport, searchItems, totpCode,
  retainItemMetadata, cipherTypeToItemType, type VaultClient, type VaultItem,
} from '@1warden/vault';
import { fromBase64, toBase64 } from '@1warden/crypto';
import { summarise } from '../../../../packages/ui/src/summary';
import { reportBrief } from '../../../../packages/ui/src/SecurityReportView';
import { linkedFieldTargets } from '../../../../packages/ui/src/item-editor-fields';
import type { ProfileCache } from './profile-cache';
import type { ApplicationSnapshot } from './types';
import type { ApplicationService, ItemDetailData, SecretRef } from './types';

/** Single-record edit is deliberate. Keys and fields owned by other workflows stay local. */
export function editableDraft(item: VaultItem): VaultItem {
  const { preservation: _preservation, ...editable } = item;
  return structuredClone({
    ...editable, wrappedKey: null, attachments: [], passwordHistory: [],
    login: item.login ? { ...item.login, fido2Credentials: [] } : null,
  });
}

/** Never trust an editor to round-trip metadata it neither displays nor owns. */
export function mergeEditableDraft(draft: VaultItem, old?: VaultItem): VaultItem {
  if (old?.nameFailed || old?.notesFailed) throw new Error('这条记录有字段无法解密，暂不能保存以免丢失原内容');
  if (old && draft.updatedAt !== old.updatedAt) throw new Error('这条记录已被更新，请重新打开编辑');
  const type = old?.type ?? draft.type;
  const rawType = old?.rawType ?? draft.rawType;
  if (type === 'unknown' || cipherTypeToItemType(rawType) !== type) throw new Error('暂不支持编辑这种条目');
  const item: VaultItem = {
    id: old?.id ?? '', type, rawType,
    name: draft.name, nameFailed: false, notes: draft.notes, notesFailed: false,
    folderId: draft.folderId, favorite: draft.favorite, reprompt: old?.reprompt ?? 0,
    createdAt: old?.createdAt ?? '', updatedAt: old?.updatedAt ?? '',
    deletedAt: old?.deletedAt ?? null, archivedAt: old?.archivedAt ?? null,
    wrappedKey: old?.wrappedKey ?? null,
    login: draft.login ? {
      username: draft.login.username, password: draft.login.password, totp: draft.login.totp,
      uris: draft.login.uris.map(({ uri, match, sourceId }) => ({ uri, match, ...(sourceId === undefined ? {} : { sourceId }) })),
      ...(draft.login.autofillOnPageLoad === undefined ? {} : { autofillOnPageLoad: draft.login.autofillOnPageLoad }),
      passwordRevisionDate: old?.login?.passwordRevisionDate ?? null,
      fido2Credentials: old?.login?.fido2Credentials ?? [],
    } : null,
    card: draft.card, identity: draft.identity, secureNote: draft.secureNote, sshKey: draft.sshKey,
    bankAccount: draft.bankAccount ?? null, driversLicense: draft.driversLicense ?? null, passport: draft.passport ?? null,
    customFields: draft.customFields.map(({ name, value, type, linkedId, sourceId, unsupportedType }) => ({ name, value, type, linkedId,
      ...(sourceId === undefined ? {} : { sourceId }), ...(unsupportedType === undefined ? {} : { unsupportedType }) })),
    passwordHistory: old?.passwordHistory ?? [], attachments: old?.attachments ?? [],
  };
  return structuredClone(old ? retainItemMetadata(old, item) : item);
}

export function itemDetail(item: VaultItem): ItemDetailData {
  return {
    summary: summarise(item), decryptionFailed: Boolean(item.preservation?.failures.length),
    rawType: item.rawType, notes: item.notes, notesFailed: item.notesFailed,
    login: item.login ? {
      username: item.login.username, uris: item.login.uris.map(({ uri, match }) => ({ uri, match })),
      hasPassword: Boolean(item.login.password), hasTotp: hasTotp(item),
      passwordRevisionDate: item.login.passwordRevisionDate, passkeyCount: item.login.fido2Credentials.length,
      passkeys: item.login.fido2Credentials.map(p => ({ credentialId: p.credentialId,
        rpId: p.rpId, rpName: p.rpName ?? null, userName: p.userName ?? null,
        userDisplayName: p.userDisplayName ?? null, creationDate: p.creationDate })),
    } : null,
    card: item.card ? {
      cardholderName: item.card.cardholderName, brand: item.card.brand,
      expMonth: item.card.expMonth, expYear: item.card.expYear,
      hasNumber: Boolean(item.card.number), hasCode: Boolean(item.card.code),
    } : null,
    identity: item.identity ? { ...item.identity } : null,
    sshKey: item.sshKey ? {
      publicKey: item.sshKey.publicKey, fingerprint: item.sshKey.fingerprint,
      hasPrivateKey: Boolean(item.sshKey.privateKey),
    } : null,
    bankAccount: item.bankAccount ? {
      bankName: item.bankAccount.bankName, nameOnAccount: item.bankAccount.nameOnAccount,
      accountType: item.bankAccount.accountType, routingNumber: item.bankAccount.routingNumber,
      branchNumber: item.bankAccount.branchNumber, swiftCode: item.bankAccount.swiftCode,
      bankContactPhone: item.bankAccount.bankContactPhone,
      hasAccountNumber: Boolean(item.bankAccount.accountNumber), hasPin: Boolean(item.bankAccount.pin),
      hasIban: Boolean(item.bankAccount.iban),
    } : null,
    driversLicense: item.driversLicense ? {
      firstName: item.driversLicense.firstName, middleName: item.driversLicense.middleName,
      lastName: item.driversLicense.lastName, dateOfBirth: item.driversLicense.dateOfBirth,
      issuingCountry: item.driversLicense.issuingCountry, issuingState: item.driversLicense.issuingState,
      issueDate: item.driversLicense.issueDate, expirationDate: item.driversLicense.expirationDate,
      issuingAuthority: item.driversLicense.issuingAuthority, licenseClass: item.driversLicense.licenseClass,
      hasLicenseNumber: Boolean(item.driversLicense.licenseNumber),
    } : null,
    passport: item.passport ? {
      surname: item.passport.surname, givenName: item.passport.givenName,
      dateOfBirth: item.passport.dateOfBirth, sex: item.passport.sex, birthPlace: item.passport.birthPlace,
      nationality: item.passport.nationality, issuingCountry: item.passport.issuingCountry,
      passportType: item.passport.passportType, issuingAuthority: item.passport.issuingAuthority,
      issueDate: item.passport.issueDate, expirationDate: item.passport.expirationDate,
      hasPassportNumber: Boolean(item.passport.passportNumber),
      hasNationalIdentificationNumber: Boolean(item.passport.nationalIdentificationNumber),
    } : null,
    customFields: item.customFields.map(f => ({ name: f.name, type: f.type, linkedId: f.linkedId,
      hasValue: f.value !== null && f.value !== '',
      value: f.type === 1 || f.type === 3 ? null : f.value })),
    passwordHistory: item.passwordHistory.map(({ lastUsedDate }) => ({ lastUsedDate })),
    attachments: item.attachments.map(({ id, fileName, size, sizeName, failed }) => ({ id, fileName, size, sizeName, failed })),
  };
}

function secretValue(item: VaultItem, field: SecretRef): string {
  let value: string | null | undefined;
  switch (field.kind) {
    case 'password': value = item.login?.password; break;
    case 'cardNumber': value = item.card?.number; break;
    case 'cardCode': value = item.card?.code; break;
    case 'privateKey': value = item.sshKey?.privateKey; break;
    case 'bankAccountNumber': value = item.bankAccount?.accountNumber; break;
    case 'bankPin': value = item.bankAccount?.pin; break;
    case 'bankIban': value = item.bankAccount?.iban; break;
    case 'licenseNumber': value = item.driversLicense?.licenseNumber; break;
    case 'passportNumber': value = item.passport?.passportNumber; break;
    case 'nationalIdentificationNumber': value = item.passport?.nationalIdentificationNumber; break;
    case 'custom': {
      const custom = item.customFields[field.index];
      if (custom?.type !== 3) { value = custom?.value; break; }
      const target = linkedFieldTargets(item.type).find(target => target.id === custom.linkedId);
      if (!target) throw new Error('无法解析这个关联字段');
      const source = item.type === 'login' ? item.login : item.type === 'card' ? item.card : item.identity;
      value = target.key === 'fullName' && item.identity
        ? [item.identity.firstName, item.identity.middleName, item.identity.lastName].filter(Boolean).join(' ')
        : (source as Record<string, unknown> | null)?.[target.key] as string | null | undefined;
      break;
    }
    case 'history': value = item.passwordHistory[field.index]?.password; break;
  }
  if (value == null) throw new Error('找不到这个字段');
  return value;
}

/** Runs beside VaultClient in either the Tauri window or extension background. */
export function createVaultService(client: VaultClient, profileCache?: ProfileCache): ApplicationService {
  let revision = 0;
  let previous: { status: string; account: unknown; syncing: boolean; syncError: string | null;
    lastSyncedAt: number | null; items: unknown; folders: unknown } | null = null;
  function activeItems() {
    const s = client.getSession();
    if (!s.isUnlocked()) throw new Error('保险库未解锁');
    return s.items.filter((i) => !i.deletedAt && !i.archivedAt && !isProfileItem(i));
  }
  function find(id: string) {
    const item = activeItems().find((i) => i.id === id);
    if (!item) throw new Error('找不到这条记录');
    return item;
  }
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    const session = client.getSession();
    const key = session.getKey();
    if (!key || !session.isUnlocked()) throw new Error('保险库未解锁');
    const result = await operation();
    if (session.getKey() !== key || !session.isUnlocked()) throw new Error('保险库已锁定，请重新解锁');
    return result;
  }
  let lastCached = '';
  let metadataTail: Promise<unknown> = Promise.resolve();
  function writeMetadata(build: (old: VaultItem | undefined) => VaultItem | undefined): Promise<void> {
    const session = client.getSession();
    const key = session.getKey();
    const result = metadataTail.then(async () => {
      if (!key || key !== session.getKey() || !session.isUnlocked()) throw new Error('保险库已锁定，请重新解锁');
      if (!client.hasVerifiedSync() || session.syncing) throw new Error('个人资料尚未完成同步，请稍候；同步失败时请重新解锁');
      const draft = build(selectProfileItem(session.items));
      if (draft) { await guarded(() => client.saveItem(draft)); await snapshot(); }
    });
    metadataTail = result.catch(() => {});
    return result;
  }
  async function snapshot(): Promise<ApplicationSnapshot> {
    const s = client.getSession();
    const account = s.account;
    const items = s.items;
    const status = s.status;
    const syncing = s.syncing;
    const syncError = client.syncError;
    const lastSyncedAt = client.lastSyncedAt;
    const profileReady = client.hasVerifiedSync() && !syncing;
    const item = s.isUnlocked() ? selectProfileItem(items) : undefined;
    let profile = null;
    let profileError = null;
    let profileSettings = null;
    let profileSettingsError = null;
    if (item) {
      try { profile = parseProfile(item); }
      catch (e) { profileError = e instanceof Error ? e.message : '个人资料读取失败'; }
      try { profileSettings = parseProfileSettings(item); }
      catch (e) { profileSettingsError = e instanceof Error ? e.message : '同步设置读取失败'; }
    }
    if (account && profileCache) {
      const signature = JSON.stringify([account.serverUrl, account.email, profile]);
      if (profile) {
        if (signature !== lastCached) { await profileCache.save(account, profile); lastCached = signature; }
      } else if (!s.isUnlocked() || !profileReady || profileError) {
        profile = await profileCache.load(account);
      } else {
        if (signature !== lastCached) { await profileCache.clear(account).catch(() => {}); lastCached = signature; }
      }
    }
    // The storage boundary may overlap lock/logout, another save or a sync.
    if (s.account !== account || s.items !== items || s.status !== status || s.syncing !== syncing
      || client.syncError !== syncError || client.lastSyncedAt !== lastSyncedAt) return snapshot();
    if (!previous || previous.status !== status || previous.account !== account || previous.syncing !== syncing
      || previous.items !== items || previous.folders !== s.folders
      || previous.syncError !== syncError || previous.lastSyncedAt !== lastSyncedAt) {
      revision++;
      previous = { status, account, syncing, syncError, lastSyncedAt, items, folders: s.folders };
    }
    return {
      revision, status, account: account ? structuredClone(account) : null, syncing, syncError, lastSyncedAt,
      profile, profileVersion: profileRevision(item), profileError, profileReady,
      profileSettings, profileSettingsError,
      items: s.isUnlocked() ? activeItems().map(summarise) : [],
      folders: s.isUnlocked() ? s.folders.map((f) => ({ ...f })) : [],
    };
  }
  return {
    snapshot,
    sync: () => guarded(() => client.refresh()),
    connect: (p) => client.connect(p),
    connectWithTwoFactor: (code, provider, remember) => client.connectWithTwoFactor(code, provider, remember),
    unlock: (password) => client.unlock(password),
    async lock() { client.lock(); },
    async logout() {
      const account = client.getSession().account;
      client.logout(); lastCached = '';
      if (account) await profileCache?.clear(account);
    },
    async switchAccount(target) {
      const account = target ? lockedAccount(target) : null;
      client.logout(); lastCached = '';
      if (account) client.getSession().setAccount(account);
    },
    async saveProfile(profile, expectedVersion) {
      return writeMetadata(old => {
        if (profileRevision(old) !== expectedVersion) throw new Error('个人资料已被更新，请重新打开设置');
        return buildProfileItem(profile, old);
      });
    },
    async savePreferences(preferences, expected) {
      const value = validatePreferences(preferences);
      const base = expected === null ? null : validatePreferences(expected);
      return writeMetadata(old => {
        const current = old ? parseProfileSettings(old).preferences : null;
        if (JSON.stringify(current) !== JSON.stringify(base)) throw new Error('同步偏好已被更新，请先载入最新设置');
        return buildPreferencesItem(value, old);
      });
    },
    async recordDevice(device) {
      return writeMetadata(old => buildDeviceItem(device, Date.now(), old));
    },
    async search(query) { return searchItems(activeItems(), client.getSession().folders, query).map((h) => summarise(h.item)); },
    async getItem(id) { return itemDetail(find(id)); },
    async getDraft(id) { return editableDraft(find(id)); },
    async saveItem(draft) {
      activeItems();
      if (isProfileItem(draft)) throw new Error('请在设置中编辑个人资料');
      const old = draft.id ? find(draft.id) : undefined;
      const saved = await guarded(() => client.saveItem(mergeEditableDraft(draft, old)));
      return summarise(saved);
    },
    async toggleFavorite(id) { find(id); await guarded(() => client.toggleFavorite(id)); },
    async moveToFolder(id, folderId) { find(id); await guarded(() => client.moveToFolder(id, folderId)); },
    async moveToTrash(id) { find(id); await guarded(() => client.moveToTrash(id)); },
    async listTrash() {
      return (await guarded(() => client.listTrash())).map(record => record.item
        ? { ...summarise(record.item), restoreError: record.restoreError }
        : { id: record.id, name: '', nameFailed: true, username: null, hasPassword: false, hasTotp: false,
          uris: [], favorite: false, folderId: null, createdAt: '', updatedAt: '', type: cipherTypeToItemType(record.rawType),
          summary: null, iconDomain: null, avatarText: '?', avatarHue: 0, restoreError: record.restoreError });
    },
    async restoreItem(id) { await guarded(() => client.restoreItem(id)); },
    async deletePermanently(id) { find(id); await guarded(() => client.deletePermanently(id)); },
    async createFolder(name) {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('请输入文件夹名称');
      return guarded(() => client.createFolder(trimmed));
    },
    async renameFolder(id, name) { await guarded(() => client.renameFolder(id, name)); },
    async deleteFolder(id) { await guarded(() => client.deleteFolder(id)); },
    async reveal(id, field) { return secretValue(find(id), field); },
    async totp(id) { return guarded(() => totpCode(find(id))); },
    async downloadAttachment(id, attachmentId) {
      find(id);
      const result = await guarded(() => client.downloadAttachment(id, attachmentId));
      return { fileName: result.fileName, dataBase64: toBase64(result.bytes) };
    },
    async uploadAttachment(id, fileName, dataBase64) {
      find(id);
      if (!fileName.trim() || /[\u0000\r\n]/u.test(fileName)) throw new Error('附件名称无效');
      const bytes = fromBase64(dataBase64);
      try { await guarded(() => client.uploadAttachment(id, fileName, bytes)); }
      finally { bytes.fill(0); }
    },
    async deleteAttachment(id, attachmentId) { find(id); await guarded(() => client.deleteAttachment(id, attachmentId)); },
    async removePasskey(id, credentialId) { find(id); await guarded(() => client.removePasskey(id, credentialId)); },
    async clearPasswordHistory(id) { find(id); await guarded(() => client.clearPasswordHistory(id)); },
    async securityReport(now) {
      return reportBrief(buildReport(activeItems(), now), (i) => i.nameFailed ? '无法解密' : i.name);
    },
    async organizationReport() { return buildOrganizationReport(activeItems()); },
    async checkBreaches() { return guarded(() => checkBreaches(activeItems())); },
    async parseImport(file) {
      const parsed = await guarded(() => parseImport(fromBase64(file.dataBase64), file.format));
      return {
        fileName: file.name, format: file.format,
        formatLabel: IMPORT_FORMATS.find((f) => f.id === file.format)?.label ?? file.format,
        total: parsed.items.length,
        byType: parsed.items.reduce<Record<string, number>>((counts, i) => {
          counts[i.type] = (counts[i.type] ?? 0) + 1; return counts;
        }, {}),
        folders: new Set(parsed.items.map((i) => i.folderName).filter((n) => n !== null)).size,
        skipped: parsed.skipped,
      };
    },
    async importData(file) {
      return guarded(async () => {
        const parsed = await parseImport(fromBase64(file.dataBase64), file.format);
        activeItems();
        return client.importItems(parsed.items);
      });
    },
  };
}
