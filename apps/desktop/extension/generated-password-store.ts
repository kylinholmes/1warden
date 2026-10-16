import { decryptString, encryptString, type SymmetricKey } from '@1warden/crypto';
import type { GeneratedPasswordSummary } from '../src/application/browser-credentials';

export interface HistoryOwner { account: string; key: SymmetricKey; assertCurrent(): void }
interface HistoryStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>, assertCurrent?: () => void): Promise<void>;
  remove(key: string): Promise<void>;
}
interface RecordBody extends GeneratedPasswordSummary { purpose: 'generated-password'; version: 1; account: string; password: string }
const MAX_AGE = 30 * 86400_000;
const storageKey = (account: string) => `1warden.generated-passwords:${account}`;

/** Only ciphertext is persisted. The caller serializes operations with vault/session writes. */
export class GeneratedPasswordStore {
  constructor(private storage: HistoryStorage, private now = Date.now) {}

  private async read(owner: HistoryOwner): Promise<RecordBody[]> {
    owner.assertCurrent();
    const value = (await this.storage.get(storageKey(owner.account)))[storageKey(owner.account)];
    owner.assertCurrent();
    if (!Array.isArray(value)) return [];
    const rows: RecordBody[] = [];
    for (const encrypted of value.slice(-100)) {
      if (typeof encrypted !== 'string') continue;
      const row: unknown = JSON.parse(await decryptString(encrypted, owner.key));
      owner.assertCurrent();
      const r = row as Partial<RecordBody> | null;
      if (!r || r.purpose !== 'generated-password' || r.version !== 1 || r.account !== owner.account
        || typeof r.id !== 'string' || typeof r.url !== 'string' || typeof r.password !== 'string'
        || typeof r.createdAt !== 'number' || r.createdAt > this.now() + 60_000) throw new Error('生成历史校验失败');
      if (r.createdAt >= this.now() - MAX_AGE) rows.push(r as RecordBody);
    }
    return rows;
  }

  private async write(owner: HistoryOwner, rows: RecordBody[]): Promise<void> {
    const encrypted = await Promise.all(rows.slice(-100).map(row => encryptString(JSON.stringify(row), owner.key)));
    owner.assertCurrent();
    await this.storage.set({ [storageKey(owner.account)]: encrypted }, () => owner.assertCurrent());
    owner.assertCurrent();
  }

  async add(owner: HistoryOwner, url: string, password: string): Promise<GeneratedPasswordSummary> {
    const rows = await this.read(owner);
    const row: RecordBody = { purpose: 'generated-password', version: 1, account: owner.account,
      id: crypto.randomUUID(), url, password, createdAt: this.now() };
    await this.write(owner, [...rows, row]);
    return { id: row.id, url: row.url, createdAt: row.createdAt };
  }

  async list(owner: HistoryOwner): Promise<GeneratedPasswordSummary[]> {
    const rows = await this.read(owner);
    // Rewriting also physically prunes expired ciphertext, without storing a plaintext index.
    await this.write(owner, rows);
    return rows.reverse().map(({ id, url, createdAt }) => ({ id, url, createdAt }));
  }

  async record(owner: HistoryOwner, id: string): Promise<RecordBody> {
    const row = (await this.read(owner)).find(row => row.id === id);
    if (!row) throw new Error('生成密码已过期或已删除');
    return row;
  }

  async reveal(owner: HistoryOwner, id: string): Promise<string> { return (await this.record(owner, id)).password; }
  async remove(owner: HistoryOwner, id: string): Promise<void> { await this.write(owner, (await this.read(owner)).filter(row => row.id !== id)); }
  async clear(account: string): Promise<void> { await this.storage.remove(storageKey(account)); }
}
