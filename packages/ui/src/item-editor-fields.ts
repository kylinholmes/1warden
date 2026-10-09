import type { CustomField, ItemType, LoginUri, VaultItem } from '@1warden/vault';
import { emptyBankAccount, emptyDriversLicense, emptyPassport } from '@1warden/vault';
import { BANK_ACCOUNT_LABEL, DRIVERS_LICENSE_LABEL, PASSPORT_LABEL } from './destinations';

export interface LinkedFieldTarget { id: number; label: string; key: string }
// Native Bitwarden linked IDs, verified in docs/reference/bitwarden-api-notes.md §2.5.
// Do not invent linked IDs for other types: those IDs are part of the upstream protocol.
const LINKED_TARGETS: Partial<Record<ItemType, readonly LinkedFieldTarget[]>> = {
  login: [
    { id: 100, label: '用户名', key: 'username' },
    { id: 101, label: '密码', key: 'password' },
  ],
  card: [
    { id: 300, label: '持卡人', key: 'cardholderName' },
    { id: 301, label: '有效月份', key: 'expMonth' },
    { id: 302, label: '有效年份', key: 'expYear' },
    { id: 303, label: '安全码', key: 'code' },
    { id: 304, label: '卡片品牌', key: 'brand' },
    { id: 305, label: '卡号', key: 'number' },
  ],
  identity: [
    { id: 400, label: '称谓', key: 'title' },
    { id: 401, label: '中间名', key: 'middleName' },
    { id: 402, label: '地址 1', key: 'address1' },
    { id: 403, label: '地址 2', key: 'address2' },
    { id: 404, label: '地址 3', key: 'address3' },
    { id: 405, label: '城市', key: 'city' },
    { id: 406, label: '省 / 州', key: 'state' },
    { id: 407, label: '邮政编码', key: 'postalCode' },
    { id: 408, label: '国家 / 地区', key: 'country' },
    { id: 409, label: '公司', key: 'company' },
    { id: 410, label: '邮箱', key: 'email' },
    { id: 411, label: '电话', key: 'phone' },
    { id: 412, label: '社会安全号 (SSN)', key: 'ssn' },
    { id: 413, label: '用户名', key: 'username' },
    { id: 414, label: '护照号码', key: 'passportNumber' },
    { id: 415, label: '驾照号码', key: 'licenseNumber' },
    { id: 416, label: '名字', key: 'firstName' },
    { id: 417, label: '姓氏', key: 'lastName' },
    { id: 418, label: '全名', key: 'fullName' },
  ],
};

export function linkedFieldTargets(type: ItemType): readonly LinkedFieldTarget[] {
  return LINKED_TARGETS[type] ?? [];
}

export function updateLoginUri<T extends LoginUri>(uris: readonly T[], index: number, patch: Partial<LoginUri>): T[] {
  return uris.map((uri, i) => i === index ? { ...uri, ...patch } : uri);
}

export function removeLoginUri<T extends LoginUri>(uris: readonly T[], index: number): T[] {
  return uris.filter((_, i) => i !== index);
}

export function savedLoginUris<T extends LoginUri>(uris: readonly T[], originals: readonly LoginUri[] = []): T[] {
  return uris.filter(uri => uri.uri !== '' || originals.some(original => original.uri === ''
    && (uri.sourceId !== undefined ? original.sourceId === uri.sourceId : original === uri)));
}

export function changeCustomFieldType<T extends CustomField>(field: T, type: CustomField['type'], itemType: ItemType): T {
  if (field.type === type) return field;
  if (type === 3) {
    const target = linkedFieldTargets(itemType)[0];
    if (!target) return field;
    return { ...field, type, value: '', linkedId: target.id };
  }
  return { ...field, type, linkedId: null, value: type === 2 ? (field.value === 'true' ? 'true' : 'false') : field.value };
}

/** Only used when the user changes a NEW item's type, never for saved records. */
export function customFieldsForItemType(fields: readonly CustomField[], itemType: ItemType): CustomField[] {
  const targets = linkedFieldTargets(itemType);
  return fields.map(field => {
    if (field.type !== 3 || targets.some(target => target.id === field.linkedId)) return field;
    return targets[0]
      ? { ...field, linkedId: targets[0].id }
      : { ...field, type: 0, linkedId: null };
  });
}


export interface NativeEditorField {
  id: string;
  label: string;
  group: string;
  keys: readonly string[];
  kind?: 'secret' | 'multiline' | 'expiry' | 'urls' | 'date' | 'compound';
  labels?: readonly string[];
}

const IDENTITY_EDITOR_GROUPS = [
  { group: '姓名与联系信息', fields: [
    ['title', '称谓'], ['firstName', '名字'], ['middleName', '中间名'], ['lastName', '姓氏'],
    ['username', '用户名'], ['company', '公司'], ['email', '邮箱'], ['phone', '电话'],
  ] },
  { group: '地址', fields: [
    ['address1', '地址 1'], ['address2', '地址 2'], ['address3', '地址 3'],
    ['city', '城市'], ['state', '省 / 州'], ['postalCode', '邮政编码'], ['country', '国家 / 地区'],
  ] },
  { group: '证件信息', fields: [
    ['ssn', '社会安全号 (SSN)'], ['passportNumber', '护照号码'], ['licenseNumber', '驾照号码'],
  ] },
] as const;

function field(id: string, label: string, group: string, kind?: NativeEditorField['kind']): NativeEditorField {
  return { id, label, group, keys: [id], ...(kind ? { kind } : {}) };
}

// Semantic groups share one responsive row; each child keeps its own label/control.
function compound(id: string, label: string, group: string, entries: readonly (readonly [string, string])[]): NativeEditorField {
  return { id, label, group, keys: entries.map(([key]) => key), labels: entries.map(([, label]) => label), kind: 'compound' };
}

export function nativeEditorFields(type: ItemType): NativeEditorField[] {
  const fields: NativeEditorField[] = type === 'login' ? [
    field('login.username', '用户名', '登录'), field('login.password', '密码', '登录', 'secret'),
    field('login.totp', '验证码', '登录', 'secret'), field('login.uris', '网址', '登录', 'urls'),
  ] : type === 'card' ? [
    field('card.cardholderName', '持卡人', '卡片'), field('card.brand', '卡片品牌', '卡片'),
    field('card.number', '卡号', '卡片', 'secret'),
    { id: 'card.expiry', label: '有效期', group: '卡片', keys: ['card.expMonth', 'card.expYear'], kind: 'expiry' },
    field('card.code', '安全码', '卡片', 'secret'),
  ] : type === 'identity' ? IDENTITY_EDITOR_GROUPS.flatMap(({ group, fields }) =>
    fields.flatMap(([key, label]) => {
      if (key === 'firstName') return [compound('identity.name', '姓名', group,
        [['identity.lastName', '姓氏'], ['identity.firstName', '名字'], ['identity.middleName', '中间名']])];
      if (key === 'middleName' || key === 'lastName' || key === 'state') return [];
      if (key === 'city') return [compound('identity.region', '地区', group,
        [['identity.state', '省 / 州'], ['identity.city', '城市']])];
      return [field(`identity.${key}`, label, group)];
    }))
  : type === 'sshKey' ? [
    field('sshKey.privateKey', '私钥', 'SSH 密钥', 'multiline'),
    field('sshKey.publicKey', '公钥', 'SSH 密钥', 'multiline'),
    field('sshKey.fingerprint', '指纹', 'SSH 密钥', 'secret'),
  ] : type === 'bankAccount' ? [
    ...Object.entries(BANK_ACCOUNT_LABEL).map(([key, label]) =>
      field(`bankAccount.${key}`, label, '银行账户', ['accountNumber', 'pin', 'iban'].includes(key) ? 'secret' : undefined)),
  ] : type === 'driversLicense' ? [
    compound('driversLicense.name', '姓名', '驾照', [['driversLicense.lastName', '姓氏'], ['driversLicense.firstName', '名字'], ['driversLicense.middleName', '中间名']]),
    ...Object.entries(DRIVERS_LICENSE_LABEL).filter(([key]) => !['firstName', 'middleName', 'lastName'].includes(key)).map(([key, label]) =>
      field(`driversLicense.${key}`, label, '驾照', key === 'licenseNumber' ? 'secret'
        : ['dateOfBirth', 'issueDate', 'expirationDate'].includes(key) ? 'date' : undefined)),
  ] : type === 'passport' ? [
    compound('passport.name', '姓名', '护照', [['passport.surname', '姓氏'], ['passport.givenName', '名字']]),
    ...Object.entries(PASSPORT_LABEL).filter(([key]) => !['surname', 'givenName'].includes(key)).map(([key, label]) =>
      field(`passport.${key}`, label, '护照', ['passportNumber', 'nationalIdentificationNumber'].includes(key) ? 'secret'
        : ['dateOfBirth', 'issueDate', 'expirationDate'].includes(key) ? 'date' : undefined)),
  ] : [];
  return [...fields, field('notes', '备注', '备注', 'multiline')];
}

export function nativeFieldValue(item: VaultItem, key: string): unknown {
  if (key === 'notes') return item.notes;
  const [group, property] = key.split('.');
  const values = (item as unknown as Record<string, unknown>)[group!];
  return values && property ? (values as Record<string, unknown>)[property] : undefined;
}

export function updateNativeField(item: VaultItem, key: string, value: string | null): VaultItem {
  if (key === 'notes') return { ...item, notes: value };
  const [group, property] = key.split('.');
  const defaults = {
    login: blankLogin, card: blankCard, identity: blankIdentity, sshKey: blankSshKey,
    bankAccount: emptyBankAccount, driversLicense: emptyDriversLicense, passport: emptyPassport,
  };
  if (!property || !(group! in defaults)) return item;
  const groupKey = group as keyof typeof defaults;
  return { ...item, [groupKey]: { ...defaults[groupKey](), ...item[groupKey], [property]: value } };
}

export function createCustomField(type: CustomField['type'], itemType: ItemType): CustomField | null {
  const target = linkedFieldTargets(itemType)[0];
  if (type === 3 && !target) return null;
  return { name: '', value: type === 2 ? 'false' : '', type, linkedId: type === 3 ? target!.id : null };
}

export function blankLogin(): NonNullable<VaultItem['login']> {
  return { username: null, password: null, totp: null, uris: [], passwordRevisionDate: null, fido2Credentials: [] };
}
export function blankCard(): NonNullable<VaultItem['card']> {
  return { cardholderName: null, brand: null, number: null, expMonth: null, expYear: null, code: null };
}
export function blankIdentity(): NonNullable<VaultItem['identity']> {
  return {
    title: null, firstName: null, middleName: null, lastName: null,
    address1: null, address2: null, address3: null, city: null, state: null,
    postalCode: null, country: null, company: null, email: null, phone: null,
    ssn: null, username: null, passportNumber: null, licenseNumber: null,
  };
}
export function blankSshKey(): NonNullable<VaultItem['sshKey']> {
  return { privateKey: null, publicKey: null, fingerprint: null };
}
export function blankEditorItem(): VaultItem {
  return {
    id: '', type: 'login', rawType: 1, name: '', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: blankLogin(), card: null, identity: null, secureNote: null, sshKey: null,
    bankAccount: null, driversLicense: null, passport: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}
