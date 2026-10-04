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
  listFolders, createFolder, updateFolder, deleteFolder,
} from '../packages/api/src/index';
import type { CipherDto } from '../packages/api/src/index';
import { deriveMasterKey, hashMasterPassword, stretchMasterKey, decryptBytes, encryptString, KDF_TYPE_PBKDF2, KDF_TYPE_ARGON2ID } from '../packages/crypto/src/index';
import type { SymmetricKey } from '../packages/crypto/src/index';
import { decryptCipher, decryptFolder, searchItems, totpCode, hasTotp, writeTotpSecret, encryptCipher, parseBitwardenCsv, VaultClient } from '../packages/vault/src/index';
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
    login: {
      username: 'e2e@example.com', password: 'kJ8#mPq2$vXn9!wZt4&bR', totp: null,
      uris: [{ uri: 'https://example.com', match: 0 }], passwordRevisionDate: null,
      // ⚠️ 不能省。`encryptCipher` 在字段缺失时**故意抛错**而不是默认成空数组 ——
      // 默认的话，一个漏了字段的调用方会把用户已有的 passkey 从服务端抹掉。
      // 所以这里必须显式写出来（这个脚本不过 tsc，只能靠运行时发现）
      fido2Credentials: [],
    },
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

  // ── 文件夹往返 ──
  //
  // 这一节针对的是一个**真实存在过的功能空洞**：API 层的文件夹 CRUD 早就写好，
  // 但界面上没有任何地方能建文件夹，条目编辑器里也没有文件夹选择器 ——
  // 于是侧栏那个「文件夹」分区永远不可能有内容。所以这里要验的是整条链路：
  // 建 → 把条目放进去 → 改名 → 删掉文件夹之后条目**还在**。
  console.log('\n5. 文件夹');

  const folderName = `e2e-folder-${Date.now().toString(36)}`;
  const folder = await createFolder(http, await encryptString(folderName, userKey));
  check('新建文件夹成功', Boolean(folder.id));

  const withFolder = { ...newItem, folderId: folder.id };
  const folderBody = await encryptCipher(withFolder, userKey, {});
  const inFolder = await createCipher(http, userId, folderBody);

  const listed = await listFolders(http);
  const found = listed.find((f) => f.id === folder.id);
  check('文件夹出现在列表里', Boolean(found));
  if (found) {
    check('文件夹名能解出来（说明名字加密方式对）',
      await decryptFolder(found, userKey).then((f) => f.name) === folderName);
  }

  // 条目里的 folderId 是**明文**字段，不走加密 —— 这一点容易搞错
  const synced = await sync(http, '');
  const syncedItem = synced.ciphers.find((c) => c.id === inFolder.id);
  check('条目真的落到了那个文件夹里', syncedItem?.folderId === folder.id,
    `folderId=${syncedItem?.folderId}`);

  const renamed = `e2e-renamed-${Date.now().toString(36)}`;
  await updateFolder(http, folder.id, await encryptString(renamed, userKey));
  const afterRename = (await listFolders(http)).find((f) => f.id === folder.id);
  check('改名成功', afterRename
    ? (await decryptFolder(afterRename, userKey)).name === renamed : false);

  await deleteFolder(http, folder.id);
  check('文件夹已删除', !(await listFolders(http)).some((f) => f.id === folder.id));

  // ⚠️ 最关键的一条：删文件夹**不该**连条目一起删掉。
  // 服务端只删关联行。界面上那句「里面的条目不会被删除」必须是真的。
  const survivor = (await sync(http, '')).ciphers.find((c) => c.id === inFolder.id);
  check('删文件夹之后条目还在（只是变成无文件夹）',
    survivor !== undefined && (survivor.folderId === null || survivor.folderId === undefined),
    survivor === undefined ? '条目被一起删掉了 —— 界面上那句承诺是假的' : `folderId=${survivor.folderId}`);

  await hardDeleteCipher(http, inFolder.id);

  // ── CSV 导入 ──
  //
  // 走**完整的那条路**（VaultClient.importItems），而不是绕开它直接调 API：
  // 导入的价值全在「用户选一个文件、条目就进去了」这一整条链上，
  // 只验解析等于没验。
  console.log('\n6. CSV 导入');

  const tag = Date.now().toString(36);
  const csv = [
    'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
    `导入测试-${tag},1,login,站点A,备注A,"PIN: 4321",0,https://a.test,userA,pwA,`,
    `导入测试-${tag},0,login,站点B,,"含引号的密码",0,https://b.test,userB,"p@ss,""word"",1",`,
    `,0,note,笔记C,"第一行\n第二行",,0,,,,`,
    `,0,login,,,,,,,,`,          // 没有名称 —— 必须被跳过并报出来
  ].join('\n');

  const parsed = parseBitwardenCsv(csv);
  check('解析出 3 条（第 4 行没有名称，跳过）', parsed.items.length === 3,
    `实际 ${parsed.items.length} 条，跳过 ${parsed.skipped.length} 条`);
  check('跳过的行带行号与原因', parsed.skipped[0]?.rowNumber === 5 && Boolean(parsed.skipped[0]?.reason),
    JSON.stringify(parsed.skipped));

  const vc = new VaultClient({
    fetchImpl: fetch,
    deviceStore: { get: () => 'e2e-import', set: () => {}, clear: () => {} },
  });
  await vc.connect({ serverUrl: BASE, email: EMAIL, masterPassword: PASSWORD });

  const before = vc.getSession().items.length;
  const imported = await vc.importItems(parsed.items);
  check('导入 3 条全部成功', imported.created === 3 && imported.failed.length === 0,
    JSON.stringify(imported));
  check('会话里多了 3 条', vc.getSession().items.length === before + 3);

  const importedNames = vc.getSession().items.map((i) => i.name);
  check('三条中文名都完整往返',
    ['站点A', '站点B', '笔记C'].every((n) => importedNames.includes(n)),
    JSON.stringify(importedNames.slice(-5)));

  // 从**服务端**再拉一次确认真的落库了，而不是只在本地会话里
  const synced2 = await sync(http, '');
  // 站点A 与 站点B 在 CSV 里写的是同一个文件夹名 —— 必须**复用**同一个文件夹，
  // 而不是各建一个（几十条同文件夹的导出会变成几十个同名文件夹）
  const siteA = vc.getSession().items.find((i) => i.name === '站点A');
  const siteB = vc.getSession().items.find((i) => i.name === '站点B');
  check('同名的文件夹被复用而不是各建一个',
    siteA?.folderId !== null && siteA?.folderId === siteB?.folderId,
    `A=${siteA?.folderId} B=${siteB?.folderId}`);

  const folderOnServer = (await listFolders(http)).find((f) => f.id === siteA?.folderId);
  check('文件夹建到了服务端', folderOnServer !== undefined, '没找到导入时建的文件夹');
  if (folderOnServer) {
    check('文件夹名解密后与 CSV 里的一致',
      (await decryptFolder(folderOnServer, userKey)).name === `导入测试-${tag}`);
  }

  const bOnServer = synced2.ciphers.find((c) => c.id === vc.getSession().items.find((i) => i.name === '站点B')?.id);
  check('含引号的密码在服务端解出来仍然完整',
    bOnServer !== undefined
    && (await decryptCipher(bOnServer, userKey)).login?.password === 'p@ss,"word",1');

  // 清理：导入的条目 + 那两个文件夹
  for (const i of vc.getSession().items.filter((x) => ['站点A', '站点B', '笔记C'].includes(x.name))) {
    await hardDeleteCipher(http, i.id).catch(() => {});
  }
  for (const f of await listFolders(http)) {
    if ((await decryptFolder(f, userKey).catch(() => ({ name: '' }))).name === `导入测试-${tag}`) {
      await deleteFolder(http, f.id).catch(() => {});
    }
  }

  await hardDeleteCipher(http, created.id);
  check('清理测试条目', true);

  console.log(failures === 0
    ? '\n✅ 端到端全部通过 —— 桌面 App 的核心链路是通的\n'
    : `\n❌ ${failures} 项失败\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
