import type { CipherWriteBody } from '@1warden/api';
import type { VaultItem } from './model';

type Row = { sourceId?: string };
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]));
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key)
    && equal((a as JsonObject)[key], (b as JsonObject)[key]));
}

/** Restore owner-only state after applying an untrusted/editable projection. */
export function retainItemMetadata(current: VaultItem, edited: VaultItem): VaultItem {
  const result: VaultItem = {
    ...edited,
    id: current.id, rawType: current.rawType, wrappedKey: current.wrappedKey,
    nameFailed: current.nameFailed, notesFailed: current.notesFailed,
    createdAt: current.createdAt, updatedAt: current.updatedAt,
    deletedAt: current.deletedAt, archivedAt: current.archivedAt,
    attachments: current.attachments,
  };
  delete result.preservation;
  if (current.preservation) result.preservation = current.preservation;
  if (result.login && result.login.autofillOnPageLoad === undefined && current.login?.autofillOnPageLoad !== undefined) {
    result.login = { ...result.login, autofillOnPageLoad: current.login.autofillOnPageLoad };
  }
  return result;
}

/** Overlay only current array members. Never index-merge arrays: deletion shifts indexes. */
function mergeRows(current: Row[], baseline: Row[], raw: unknown, encoded: unknown, kind: string): unknown[] {
  const originals = Array.isArray(raw) ? raw : [];
  const encrypted = Array.isArray(encoded) ? encoded : [];
  const seen = new Set<string>();
  return current.map((row, i) => {
    if (!row.sourceId) return encrypted[i];
    if (seen.has(row.sourceId)) throw new Error('条目列表标识重复，请重新同步后编辑');
    seen.add(row.sourceId);
    const prior = baseline.find((candidate) => candidate.sourceId === row.sourceId);
    const index = baseline.findIndex((candidate) => candidate.sourceId === row.sourceId);
    if (!prior || !row.sourceId.startsWith(`${kind}:`) || !Number.isInteger(index) || !originals[index]) {
      throw new Error('条目列表已变化，请重新同步后编辑');
    }
    if (equal(row, prior)) return structuredClone(originals[index]);
    if ('unsupportedType' in prior) throw new Error('此自定义字段类型暂不支持编辑，请保持原样或使用兼容客户端修改');
    const original = object(originals[index]);
    const merged = { ...original, ...object(encrypted[i]) };
    // A change to one field must not normalize other native data (including nulls
    // and unsupported credential algorithms) that the editor did not change.
    for (const name of Object.keys(object(encrypted[i]))) {
      if (name in prior && name in row && name in original && equal(object(prior)[name], object(row)[name])) {
        merged[name] = original[name];
      }
    }
    if (kind === 'uri' && 'uri' in row && 'uri' in prior && row.uri === prior.uri && 'uriChecksum' in object(originals[index])) {
      merged.uriChecksum = object(originals[index]).uriChecksum;
    }
    return merged;
  });
}

/** Merge unknown server data into a freshly encoded body; supported edits always win. */
export function preserveCipherData(item: VaultItem, body: CipherWriteBody): CipherWriteBody {
  const state = item.preservation;
  if (!state) return body;
  if (state.failures.length) throw new Error('条目包含无法解密或读取的字段，已阻止保存以保护原数据；请重新同步，或用兼容客户端修复后再编辑');
  if (item.wrappedKey !== (state.source.key ?? null)) throw new Error('条目密钥已变化，请重新同步后编辑');
  const source: JsonObject = structuredClone(state.source) as unknown as JsonObject;
  // Response-only properties are never sent back as writable data. Resource changes
  // use dedicated endpoints; archive/revision changes require explicit options.
  for (const name of ['id', 'object', 'creationDate', 'revisionDate', 'deletedDate', 'archivedDate',
    'attachments', 'permissions', 'edit', 'viewPassword', 'organizationUseTotp', 'encryptedFor',
    'lastKnownRevisionDate']) delete source[name];
  const result = { ...source, ...body, organizationId: state.source.organizationId ?? null } as CipherWriteBody;
  for (const name of ['login', 'card', 'identity', 'secureNote', 'sshKey'] as const) {
    if (body[name] != null) result[name] = { ...object(source[name]), ...object(body[name]) } as never;
    else if (item.type !== state.baseline.type) delete result[name];
  }
  if (body.login && item.login) {
    const login = result.login!;
    delete login.uri; // Legacy alias must not resurrect a removed first URL.
    login.uris = mergeRows(item.login.uris, state.baseline.login?.uris ?? [], state.source.login?.uris, body.login.uris, 'uri') as NonNullable<typeof login.uris>;
    login.fido2Credentials = mergeRows(item.login.fido2Credentials, state.baseline.login?.fido2Credentials ?? [], state.source.login?.fido2Credentials, body.login.fido2Credentials, 'passkey') as NonNullable<typeof login.fido2Credentials>;
  }
  result.fields = item.customFields.length ? mergeRows(item.customFields, state.baseline.customFields, state.source.fields, body.fields, 'field') as NonNullable<typeof body.fields> : null;
  result.passwordHistory = item.passwordHistory.length ? mergeRows(item.passwordHistory, state.baseline.passwordHistory, state.source.passwordHistory, body.passwordHistory, 'history') as NonNullable<typeof body.passwordHistory> : null;
  return result;
}
