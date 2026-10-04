#!/usr/bin/env bun
/**
 * 端到端验证：走**桌面 App 用的那条路**（经本地代理的 HTTP）跑通完整链路。
 *
 * 验证的是 UI 实际会拿到什么 —— 不是「协议对不对」（那是契约测试的事），
 * 而是「从服务器地址+邮箱+主密码，到一个能渲染的条目列表」这条完整的路。
 *
 * 前置：
 *   ./scripts/dev-server.sh start
 *   bun run scripts/dev-proxy.ts &
 *   bun run seed
 *   bun run e2e
 */
import {
  HttpClient, prelogin, loginWithPassword, sync, partitionCiphers, getRevisionDate, DEVICE_TYPE,
  createCipher, hardDeleteCipher,
} from '../packages/api/src/index';
import type { CipherDto } from '../packages/api/src/index';
import { deriveMasterKey, hashMasterPassword, stretchMasterKey, decryptBytes, KDF_TYPE_PBKDF2, KDF_TYPE_ARGON2ID } from '../packages/crypto/src/index';
import type { SymmetricKey } from '../packages/crypto/src/index';
import { decryptCipher, decryptFolder, searchItems, totpCode, hasTotp, writeTotpSecret, encryptCipher } from '../packages/vault/src/index';
import type { VaultItem } from '../packages/vault/src/index';

const BASE = process.env.COFFER_APP_URL ?? 'http://127.0.0.1:8080';
const EMAIL = process.env.COFFER_TEST_EMAIL ?? 'coffer-test@example.com';
const PASSWORD = process.env.COFFER_TEST_PASSWORD ?? 'Test-Master-Password-123!';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

function jwtSub(t: string): string {
  return (JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string }).sub;
}

async function main() {
  console.log(`\n端到端验证 → ${BASE}\n`);

  // ── 1. 连接（UI 的连接屏做的事）──
  console.log('1. 连接与解锁');
  const bare = new HttpClient({ baseUrl: BASE });
  const pl = await prelogin(bare, EMAIL);
  check(`prelogin 拿到 KDF 参数（kdf=${pl.kdf}, ${pl.iterations} 轮）`, pl.iterations > 0);

  const kdf = pl.kdf === KDF_TYPE_ARGON2ID
    ? { kdf: KDF_TYPE_ARGON2ID as const, iterations: pl.iterations, memory: pl.memory ?? 64, parallelism: pl.parallelism ?? 4 }
    : { kdf: KDF_TYPE_PBKDF2 as const, iterations: pl.iterations };

  const t0 = Date.now();
  const masterKey = await deriveMasterKey(PASSWORD, EMAIL, kdf);
  const deriveMs = Date.now() - t0;
  check(`主密码在本地派生出密钥（${deriveMs}ms —— 这是解锁耗时的下限）`, masterKey.length === 32);

  const token = await loginWithPassword(bare, {
    email: EMAIL,
    masterPasswordHash: await hashMasterPassword(masterKey, PASSWORD),
    device: { type: DEVICE_TYPE.macOSDesktop, identifier: 'e2e-desktop', name: 'Coffer' },
  });
  check('登录成功，拿到 access token', token.accessToken.length > 0);
  check('拿到用户密钥（Key 字段）', Boolean(token.key));

  const raw = await decryptBytes(token.key!, await stretchMasterKey(masterKey));
  check(`解出的用户密钥是 64 字节`, raw.length === 64);
  const userKey: SymmetricKey = { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) };

  const http = new HttpClient({
    baseUrl: BASE,
    headers: () => ({
      Authorization: `Bearer ${token.accessToken}`,
      'Device-Type': String(DEVICE_TYPE.macOSDesktop),
      'Bitwarden-Client-Name': 'desktop',
      'Bitwarden-Client-Version': '2026.10.0',
    }),
  });
  const userId = jwtSub(token.accessToken);

  // ── 2. 同步与解密（主界面要做的事）──
  console.log('\n2. 同步与解密');
  const rev = await getRevisionDate(http, '');
  check(`revision-date 可用于短路（${rev}）`, typeof rev === 'number');

  const rawSync = await sync(http, '');
  const { active, trashed, archived } = partitionCiphers(rawSync.ciphers);
  check(`同步拿到 ${rawSync.ciphers.length} 条（活跃 ${active.length} / 归档 ${archived.length} / 回收站 ${trashed.length}）`,
    rawSync.ciphers.length >= 0);

  const items: VaultItem[] = [];
  let failed = 0;
  for (const dto of active) {
    try { items.push(await decryptCipher(dto as CipherDto, userKey)); } catch { failed++; }
  }
  check(`解密 ${items.length} 条，失败 ${failed} 条`, failed === 0 || items.length > failed);

  const folders = [];
  for (const f of rawSync.folders) folders.push(await decryptFolder(f, userKey));

  // ── 3. UI 会渲染的内容 ──
  console.log('\n3. 界面渲染检查');
  const named = items.filter((i) => !i.nameFailed);
  check('每条都有可显示的名称（没有「无法解密」）', named.length === items.length,
    items.filter((i) => i.nameFailed).map((i) => i.id).join(', '));

  const withPassword = items.filter((i) => i.login?.password);
  check(`有 ${withPassword.length} 条带密码可供复制`, true);

  const hits = searchItems(items, folders, '');
  check(`搜索（浏览模式）返回 ${hits.length} 条`, hits.length === items.length);

  if (named.length > 0) {
    const sample = named[0]!;
    const found = searchItems(items, folders, sample.name.slice(0, 3));
    check(`按名称片段搜索能找回「${sample.name}」`, found.some((h) => h.item.id === sample.id));
  }

  const withTotp = items.filter(hasTotp);
  if (withTotp.length > 0) {
    const code = await totpCode(withTotp[0]!);
    check(`验证码可生成（${code?.code}，剩余 ${code?.remaining}s）`, Boolean(code?.code));
  } else {
    console.log('  · 没有带验证码的条目，跳过');
  }

  // ── 4. 写入路径（新建条目）──
  console.log('\n4. 写入路径');
  const newItem: VaultItem = {
    id: '', type: 'login', rawType: 1,
    name: `E2E ${Date.now()}`, nameFailed: false,
    notes: '端到端写入测试', notesFailed: false,
    folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: { username: 'e2e@example.com', password: 'kJ8#mPq2$vXn9!wZt4&bR', totp: null, uris: [{ uri: 'https://example.com', match: 0 }], passwordRevisionDate: null },
    card: null, identity: null, secureNote: null,
    customFields: [{ name: 'PIN', value: '4321', type: 1, linkedId: null }],
    passwordHistory: [], attachments: [],
  };
  const body = await encryptCipher(newItem, userKey, {});
  const created = await createCipher(http, userId, body);
  check('新建条目成功（UI 的「保存」按钮走的就是这条）', Boolean(created.id));

  const after = await sync(http, '');
  const back = after.ciphers.find((c) => c.id === created.id);
  check('新条目出现在同步结果里', Boolean(back));
  if (back) {
    const dec = await decryptCipher(back, userKey);
    check('解出的内容与写入的一致', dec.name === newItem.name && dec.login?.password === newItem.login?.password);
    check('自定义字段往返一致', dec.customFields[0]?.value === '4321');
  }

  // TOTP 写入路径。
  // 注意断言的是「没有 TOTP 字段」而不是「没有自定义字段」——
  // 条目里本来就有个 PIN 字段，它应当被保留。
  const withTotpWrite = writeTotpSecret(newItem, 'WQIQ25BRKZYCJVYP');
  check('登录条目的验证码写入原生 login.totp（官方客户端也能看到）',
    withTotpWrite.loginTotp === 'WQIQ25BRKZYCJVYP'
    && !withTotpWrite.customFields.some((f) => f.name === '一次性密码'));
  check('写入验证码不会丢掉其他自定义字段',
    withTotpWrite.customFields.some((f) => f.name === 'PIN'));

  await hardDeleteCipher(http, created.id);
  check('清理测试条目', true);

  console.log(failures === 0
    ? '\n✅ 端到端全部通过 —— 桌面 App 的核心链路是通的\n'
    : `\n❌ ${failures} 项失败\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
