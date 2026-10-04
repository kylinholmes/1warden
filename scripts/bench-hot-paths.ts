/**
 * 热路径基准 —— 用来回答「这个东西该不该搬去 Rust」。
 *
 * ⚠️ **搬之前先量。** 跨语言边界的代价是实打实的：调试变难、两套测试、
 * 每加一个字段都要同步两边。为了「感觉会慢」去搬，是把确定的复杂度
 * 换一个想象中的收益。
 *
 * 判据：
 *   - **搜索类**：会在用户每敲一个键时跑 → 要低于一帧（16.7ms）
 *   - **解密类**：解锁/同步时一次性跑 → 几百毫秒可以接受（有加载态），
 *     但要随条目数**线性**，不能是平方
 *
 * 跑法：`bun scripts/bench-hot-paths.ts`
 */
import { searchItems } from '../packages/vault/src/search';
import { decryptCipher } from '../packages/vault/src/decrypt';
import { encryptCipher } from '../packages/vault/src/encrypt';
import { emptyLogin, emptyCard, emptyIdentity, type VaultItem } from '../packages/vault/src/model';
import { makeUserKey, encryptString } from '../packages/crypto/src/index';
import type { CipherDto } from '../packages/api/src/index';

const key = makeUserKey();

function item(id: string, name: string): VaultItem {
  return {
    id, type: 'login', rawType: 1, name, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: { ...emptyLogin(), fido2Credentials: [] },
    card: emptyCard(), identity: emptyIdentity(), secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

// ── 1. 搜索：桌面端每敲一个键就跑一次 ──
for (const n of [1000, 5000, 20000]) {
  const items = Array.from({ length: n }, (_, i) => item(String(i), `站点-${i}-github`));
  const t0 = performance.now();
  const ROUNDS = 20;
  for (let r = 0; r < ROUNDS; r++) searchItems(items, [], 'gith');
  const per = (performance.now() - t0) / ROUNDS;
  console.log(`搜索 ${n} 条：${per.toFixed(2)} ms/次`);
}

// ── 2. 解密：每次解锁/同步要对所有条目跑一遍 ──
for (const n of [200, 1000]) {
  const dtos: CipherDto[] = [];
  for (let i = 0; i < n; i++) {
    const body = await encryptCipher(item(String(i), `站点-${i}`), key, {});
    dtos.push({
      id: String(i), type: 1,
      name: await encryptString(`站点-${i}`, key),
      notes: await encryptString('一段备注'.repeat(20), key),
      folderId: null, favorite: false, reprompt: 0,
      organizationId: null, key: null,
      creationDate: '', revisionDate: '', deletedDate: null, archivedDate: null,
      login: body.login ?? null,
      fields: [{ name: await encryptString('PIN', key), value: await encryptString('4321', key), type: 0, linkedId: null }],
      passwordHistory: [],
    });
  }
  const t0 = performance.now();
  for (const d of dtos) await decryptCipher(d, key);
  const ms = performance.now() - t0;
  console.log(`解密 ${n} 条（每条约 9 个字段）：${ms.toFixed(1)} ms  (${(ms / n).toFixed(2)} ms/条)`);
}
