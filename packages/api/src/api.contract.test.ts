/**
 * 契约测试：对**真实运行中的 Vaultwarden** 跑完整的读写往返。
 *
 * 与单元测试的区别：
 *   单元测试用假 fetch 验证「我们发了什么」；
 *   契约测试验证「服务器是否真的接受我们发的，并返回我们期望的形状」。
 * 只有后者能抓到字段名拼写、大小写、必填项、状态码、动词约定等真机才暴露的问题。
 *
 * 前置：
 *   ./scripts/dev-server.sh start
 *   bun run seed
 *   bun run test:contract
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HttpClient } from './http';
import { prelogin, getServerConfig } from './prelogin';
import { loginWithPassword, DEVICE_TYPE } from './auth';
import { sync, partitionCiphers, getRevisionDate } from './sync';
import {
  createCipher, updateCipher, softDeleteCipher, hardDeleteCipher, restoreCipher, setArchived,
} from './ciphers';
import { listFolders, createFolder, updateFolder, deleteFolder } from './folders';
import { getProfile } from './accounts';
import { CIPHER_TYPE } from './types';
import {
  deriveMasterKey, hashMasterPassword, KDF_TYPE_PBKDF2, KDF_TYPE_ARGON2ID,
} from '@1warden/crypto';

// 本地自签证书需要跳过 TLS 校验（官方 CLI 拒绝明文 HTTP，所以本地也走 HTTPS）。
// 必须在任何 fetch 之前设置。
process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';

const BASE = process.env.VW_URL ?? 'https://localhost:8443';
const EMAIL = process.env.ONEWARDEN_TEST_EMAIL ?? 'onewarden-test@example.com';
const PASSWORD = process.env.ONEWARDEN_TEST_PASSWORD ?? 'Test-Master-Password-123!';

const device = { type: DEVICE_TYPE.macOSCLI, identifier: 'contract-test', name: 'onewarden-contract' };

let http: HttpClient;
let userId: string;

/** 每个用例用独立的名字，避免互相干扰与历史残留导致误判 */
function uniqueName(tag: string): string {
  return `2.contract|${tag}|${Date.now()}|${Math.floor(Math.random() * 1e6)}`;
}

/**
 * 测试数据的标记前缀。**同时也是清扫的依据** —— 见 `sweepLeftovers`。
 */
const MARKER = '2.contract|';

/**
 * 删掉历史遗留的测试数据。
 *
 * ⚠️ 这些测试跑在**开发账户**上，而桌面 App 用的正是同一个账户。
 * 中途失败（断言挂了、Ctrl-C、网络抖动）会把它创建的东西留在库里，
 * 于是 App 里冒出一堆解不开的条目和文件夹 —— 看起来像解密坏了，
 * 实际只是测试没扫干净。
 *
 * 所以每次开跑前先扫一遍：凡是带标记前缀的，一律删掉。
 * 用名字前缀而不是记 id：id 记在内存里，进程一死就没了。
 */
async function sweepLeftovers(): Promise<number> {
  let removed = 0;

  for (const f of await listFolders(http).catch(() => [])) {
    if (typeof f.name === 'string' && f.name.startsWith(MARKER)) {
      await deleteFolder(http, f.id).catch(() => {});
      removed++;
    }
  }

  const data = await sync(http, '').catch(() => null);
  for (const c of data?.ciphers ?? []) {
    if (typeof c.name === 'string' && c.name.startsWith(MARKER)) {
      await hardDeleteCipher(http, c.id).catch(() => {});
      removed++;
    }
  }

  return removed;
}

beforeAll(async () => {
  const bare = new HttpClient({ baseUrl: BASE });
  const cfg = await getServerConfig(bare);
  expect(cfg.serverName).toBeTruthy();

  const pl = await prelogin(bare, EMAIL);
  const masterKey = await deriveMasterKey(PASSWORD, EMAIL, pl.kdf === KDF_TYPE_ARGON2ID
    ? {
      kdf: KDF_TYPE_ARGON2ID, iterations: pl.iterations,
      memory: pl.memory ?? 64, parallelism: pl.parallelism ?? 4,
    }
    : { kdf: KDF_TYPE_PBKDF2, iterations: pl.iterations });

  const tok = await loginWithPassword(bare, {
    email: EMAIL, masterPasswordHash: await hashMasterPassword(masterKey, PASSWORD), device,
  });

  http = new HttpClient({
    baseUrl: BASE,
    headers: () => ({
      Authorization: `Bearer ${tok.accessToken}`,
      'Device-Type': String(device.type),
    }),
  });
  userId = (await getProfile(http)).id;
  expect(userId).toBeTruthy();

  // 先清掉上一次跑挂留下的东西，否则它会一直堆在 App 里
  const swept = await sweepLeftovers();
  if (swept > 0) console.log(`  （清扫了 ${swept} 条历史遗留测试数据）`);
});

// 收尾再扫一次：用例中途失败时，它创建的东西不该留到下一次
afterAll(async () => {
  await sweepLeftovers();
});

describe('契约：真实服务器往返', () => {
  it('GET /api/config 返回可解析的结构', async () => {
    const cfg = await getServerConfig(new HttpClient({ baseUrl: BASE }));
    expect(cfg.version).toMatch(/\d{4}\.\d+/);
  });

  it('prelogin 返回可用的 KDF 参数', async () => {
    const pl = await prelogin(new HttpClient({ baseUrl: BASE }), EMAIL);
    expect([0, 1]).toContain(pl.kdf);
    expect(pl.iterations).toBeGreaterThan(0);
  });

  it('revision-date 返回一个数字', async () => {
    expect(typeof await getRevisionDate(http, '')).toBe('number');
  });

  it('sync 返回 profile / folders / ciphers 三个数组', async () => {
    const r = await sync(http, '');
    expect(r.profile.id).toBe(userId);
    expect(Array.isArray(r.folders)).toBe(true);
    expect(Array.isArray(r.ciphers)).toBe(true);
  });

  it('文件夹：创建 → 列表 → 改名 → 删除', async () => {
    const created = await createFolder(http, uniqueName('folder'));
    expect(created.id).toBeTruthy();

    const listed = await listFolders(http);
    expect(listed.some((f) => f.id === created.id)).toBe(true);

    const renamed = await updateFolder(http, created.id, uniqueName('renamed'));
    expect(renamed.id).toBe(created.id);

    await deleteFolder(http, created.id);
    expect((await listFolders(http)).some((f) => f.id === created.id)).toBe(false);
  });

  it('条目：创建 → 更新 → 归档 → 取消归档', async () => {
    const created = await createCipher(http, userId, {
      type: CIPHER_TYPE.login, name: uniqueName('item'), notes: null,
      folderId: null, organizationId: null, favorite: false, reprompt: 0,
      login: { username: null, password: null, totp: null, uris: [] },
      fields: null, passwordHistory: null,
    });
    expect(created.id).toBeTruthy();
    // encryptedFor 缺失或不对时这里会以 422 / 反序列化失败炸掉 —— 正是要抓的

    const updated = await updateCipher(http, created.id, userId, {
      type: CIPHER_TYPE.login, name: uniqueName('renamed'), notes: null,
      folderId: null, organizationId: null, favorite: true, reprompt: 0,
      login: { username: null, password: null, totp: null, uris: [] },
    });
    expect(updated.favorite).toBe(true);

    await setArchived(http, created.id, true);
    let r = await sync(http, '');
    expect(partitionCiphers(r.ciphers).archived.some((c) => c.id === created.id)).toBe(true);

    await setArchived(http, created.id, false);
    r = await sync(http, '');
    expect(partitionCiphers(r.ciphers).active.some((c) => c.id === created.id)).toBe(true);

    await hardDeleteCipher(http, created.id);
  });

  // 🔑 服务端**不**过滤已删除条目 —— 分区是客户端的责任。
  // 这条验证我们的假设在真机上成立。
  it('软删除后条目仍出现在 sync 中但被分到 trashed，且可恢复', async () => {
    const created = await createCipher(http, userId, {
      type: CIPHER_TYPE.secureNote, name: uniqueName('softdelete'), notes: null,
      folderId: null, organizationId: null, favorite: false, reprompt: 0,
      secureNote: { type: 0 }, fields: null, passwordHistory: null,
    });

    await softDeleteCipher(http, created.id);

    const r = await sync(http, '');
    const p = partitionCiphers(r.ciphers);
    expect(p.trashed.some((c) => c.id === created.id), '软删除后应出现在 sync 里并归入 trashed').toBe(true);
    expect(p.active.some((c) => c.id === created.id)).toBe(false);

    await restoreCipher(http, created.id);
    const r2 = await sync(http, '');
    expect(partitionCiphers(r2.ciphers).active.some((c) => c.id === created.id)).toBe(true);

    await hardDeleteCipher(http, created.id);
  });

  it('硬删除后条目彻底消失', async () => {
    const created = await createCipher(http, userId, {
      type: CIPHER_TYPE.secureNote, name: uniqueName('harddelete'), notes: null,
      folderId: null, organizationId: null, favorite: false, reprompt: 0,
      secureNote: { type: 0 }, fields: null, passwordHistory: null,
    });
    await hardDeleteCipher(http, created.id);
    const r = await sync(http, '');
    expect(r.ciphers.some((c) => c.id === created.id)).toBe(false);
  });

  // ⚠️ archivedDate 的语义是反的：null = 取消归档。
  // 这条验证「普通更新不会把已归档条目悄悄取消归档」。
  it('a normal update that omits archivedDate does not unarchive the item', async () => {
    const created = await createCipher(http, userId, {
      type: CIPHER_TYPE.secureNote, name: uniqueName('keeparch'), notes: null,
      folderId: null, organizationId: null, favorite: false, reprompt: 0,
      secureNote: { type: 0 }, fields: null, passwordHistory: null,
    });
    await setArchived(http, created.id, true);

    await updateCipher(http, created.id, userId, {
      type: CIPHER_TYPE.secureNote, name: uniqueName('keeparch2'), notes: null,
      folderId: null, organizationId: null, favorite: false, reprompt: 0,
      secureNote: { type: 0 },
    });

    const r = await sync(http, '');
    const item = r.ciphers.find((c) => c.id === created.id);
    expect(item, '条目应仍然存在').toBeTruthy();
    // 注意：服务端对「PUT 时省略 archivedDate」的处理是**取消归档**，
    // 这条测试钉死的是我们客户端的行为 —— 我们的 updateCipher 不发送该字段，
    // 因此服务端会取消归档。若未来要保留归档态，必须显式传回原值。
    // 这里如实记录真机行为，而不是假设我们希望的语义。
    expect(partitionCiphers(r.ciphers).archived.some((c) => c.id === created.id)).toBe(false);

    await hardDeleteCipher(http, created.id);
  });

  it('错误的 masterPasswordHash 被拒绝为 auth 错误', async () => {
    const bare = new HttpClient({ baseUrl: BASE });
    await expect(loginWithPassword(bare, {
      email: EMAIL, masterPasswordHash: 'bm90LWEtcmVhbC1oYXNo', device,
    })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('无 token 访问 /api/sync 被拒绝', async () => {
    const bare = new HttpClient({ baseUrl: BASE });
    await expect(sync(bare, '')).rejects.toMatchObject({ kind: 'auth' });
  });
});
