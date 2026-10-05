/**
 * passkey 的服务端 —— 在 background 里跑，页面看不到这里的一切。
 *
 * ## 职责分界
 *
 *   webauthn-inject.ts  （MAIN world）  翻译参数、包装返回值。什么都**不**判断
 *   content.ts          （隔离世界）    搬运。什么都**不**判断
 *   **本文件**          （background）  所有判断都在这里
 *
 * 前两者的输入全部由页面控制，包括它自称的 origin。所以本文件一律以
 * `sender.origin`（浏览器填的、页面改不了的）为准 —— 这条是整个 passkey
 * 功能的信任根，写错了等于把域隔离整个送掉。
 */
import {
  createPasskey, assertPasskey, pickCredentials, isRpIdAllowed, originOf,
  relyingPartyOf, checkClientData,
  type VaultItem, type Candidate, type StoredPasskey, type AccountInfo,
} from '@coffer/vault';
import { toBase64Url, type SymmetricKey } from '@coffer/crypto';

interface CreatePayload {
  op: 'create';
  challenge: string | null;
  rp: { id: string | null; name: string };
  user: { id: string | null; name: string; displayName: string };
}

interface GetPayload {
  op: 'get';
  rpId: string | null;
  challenge: string | null;
  allowCredentials: { id: string; type: string }[] | null;
  userVerification: string;
}

export type WebauthnPayload = CreatePayload | GetPayload;

export interface WebauthnDeps {
  items: () => readonly VaultItem[];
  isUnlocked: () => boolean;
  /** 诊断追踪。见 background.ts 里 trace 的说明 —— 两个 SW 实例时控制台会丢日志 */
  trace: (line: string) => Promise<void>;
  /**
   * 从服务端重新同步一次。
   *
   * ⚠️ 注册前**必须**调用，不能省。见 `handleCreate` 里的说明。
   */
  refresh: () => Promise<void>;
  userKey: () => SymmetricKey;
  /**
   * 把**改动过的**条目存回服务端，并刷新会话快照。
   *
   * 传改动集而不是整个数组：调用方知道改了哪几条，让它自己去 diff 是
   * 把「哪些条目脏了」这个信息丢掉再猜回来，猜错就是漏存或多存。
   */
  persist: (changed: readonly VaultItem[]) => Promise<void>;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** 主机名。origin 已经由 originOf 归一化过 */
function hostOf(origin: string): string {
  return new URL(origin).hostname.toLowerCase();
}

/**
 * 组装 clientDataJSON。
 *
 * 这是**我们**的产出，不是页面给的 —— RP 提供 challenge，客户端负责把
 * 它连同 origin 一起封装成 clientDataJSON。签名覆盖的是它的 SHA-256。
 *
 * ⚠️ challenge 在 clientDataJSON 里是 **base64url 字符串**，不是原始字节。
 * 写成字节数组的话签名照样算得出，但 RP 收到的 challenge 对不上，
 * 报错只有一句「challenge mismatch」。
 */
function buildClientData(type: string, challenge: string, origin: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    type,
    challenge,
    origin,
    crossOrigin: false,
  }));
}

/**
 * 建一条 passkey。
 *
 * ## 关于「存到哪一条」
 *
 * 优先挂到**已经有同一 rpId 凭据**的条目上（用户在这个站有多个账号时，
 * 他上次选的那条就是他想继续用的）；否则挂到 URL 匹配的唯一一条上；
 * 都没有就新建一条以域名命名的登录条目。
 *
 * ⚠️ **已知缺口**：这里没有「是否保存」的确认界面，页面可以直接写入一条
 * 新条目。而页面只能为自己的 origin（及其父域）注册 —— 我们卡住了 rpId ——
 * 所以危害限于「往保险库里塞条目」，不是凭据泄露。但这个界面该补。
 */
async function handleCreate(
  payload: CreatePayload, origin: string, deps: WebauthnDeps,
): Promise<Record<string, unknown>> {
  const host = hostOf(origin);
  const rpId = payload.rp.id ?? host;

  if (!isRpIdAllowed(origin, rpId)) {
    return fail(`这个页面（${host}）不能为 ${rpId} 创建 passkey`);
  }
  if (payload.challenge === null || payload.challenge.length === 0) {
    return fail('缺少 challenge');
  }

  const created = await createPasskey({
    rpId,
    rpName: payload.rp.name,
    userVerified: true,   // 保险库已解锁 —— 用户刚刚验证过自己
    ...(payload.user.id !== null ? { userHandle: payload.user.id } : {}),
    ...(payload.user.name.length > 0 ? { userName: payload.user.name } : {}),
    ...(payload.user.displayName.length > 0 ? { userDisplayName: payload.user.displayName } : {}),
  });

  const clientData = buildClientData('webauthn.create', payload.challenge, origin);
  // ⚠️ 签名前的最后一道：确认我们**自己**组装出来的 clientDataJSON 里，
  // origin 确实是浏览器报告的那个。挡的是「origin 被页面参数污染」这类
  // 组装错误 —— 那种错误一旦签出去，就是一份 origin 写着别人域名的凭据。
  const check = checkClientData(clientData, 'webauthn.create', origin);
  if (!check.ok) return fail(`内部校验失败：${check.reason}`);

  /**
   * ⚠️ **先同步，再决定往哪条条目上挂。**
   *
   * 这里防的是一个真实发生过、且症状极具迷惑性的数据丢失：
   *
   * MV3 的 service worker 会在一次 create 处理到一半时被杀。同一个请求被新的
   * 实例又跑了一遍，而新实例从存储恢复出来的会话是**第一次落盘之前**的快照
   * （凭据列表还是空的）。于是它整条写回去，把第一次刚存的凭据覆盖掉了。
   *
   * 页面拿到的是第一次的 credentialId（它先返回），库里躺着第二次的 ——
   * 之后用 allowCredentials 登录报「没有可用的 passkey」，看起来像匹配逻辑坏了，
   * 而匹配逻辑完全正确。为了找到这里绕了很久。
   *
   * 内存里的幂等表挡不住这个：第一次执行**没有被记录的机会**，它被杀了。
   * 唯一可靠的办法是拿服务端的真相来合并 —— 服务端那边两次都存下来了。
   */
  const idsOf = (): string[] => deps.items()
    .flatMap((i) => i.login?.fido2Credentials ?? [])
    .filter((c) => c.rpId === rpId).map((c) => c.credentialId.slice(0, 8));
  const before = idsOf();
  await deps.refresh();
  await deps.trace(`create 同步：前=${JSON.stringify(before)} 后=${JSON.stringify(idsOf())}`
    + ` 条目总数=${deps.items().length} 本实例解锁=${deps.isUnlocked()}`
    + ` 新凭据=${created.stored.credentialId.slice(0, 8)}`);
  const target = findTarget(deps.items(), rpId, origin);
  await deps.trace(`create 目标条目=${target?.id ?? '(新建)'} 该条目已有凭据=${
    target?.login?.fido2Credentials.length ?? 0}`);
  const updated: VaultItem = target === null
    ? newPasskeyItem(rpId, created.stored.userName ?? null, origin, created.stored)
    : { ...target, login: withCredential(target, created.stored) };
  await deps.persist([updated]);

  return {
    ok: true,
    credentialId: toBase64Url(created.credentialId),
    clientDataJSON: toBase64Url(clientData),
    attestationObject: toBase64Url(created.attestationObject),
  };
}

/** 在条目上追加一条凭据。条目一定已经过 findTarget 筛选，login 非空 */
function withCredential(item: VaultItem, stored: StoredPasskey): NonNullable<VaultItem['login']> {
  return {
    ...item.login!,
    fido2Credentials: [...item.login!.fido2Credentials, stored],
  };
}

/**
 * 做一次断言。
 *
 * ⚠️ 这里**没有选择界面**：多个候选时取第一个。这是已知缺口 ——
 * 用户在同一站点有多个账号时会拿到哪个不确定。真实的客户端会弹一个列表，
 * 那是下一步要补的。当前行为至少是确定性的：按条目在保险库里的顺序。
 */
async function handleGet(
  payload: GetPayload, origin: string, deps: WebauthnDeps,
): Promise<Record<string, unknown>> {
  const host = hostOf(origin);
  const rpId = payload.rpId ?? host;

  if (!isRpIdAllowed(origin, rpId)) {
    return fail(`这个页面（${host}）不能使用 ${rpId} 的 passkey`);
  }
  if (payload.challenge === null || payload.challenge.length === 0) {
    return fail('缺少 challenge');
  }

  /**
   * ⚠️ 断言前也要同步 —— 理由和 create 那边一样，但更容易踩：
   *
   * 注册与登录经常是**两个不同的 service worker 实例**处理的（SW 重启）。
   * 注册那个实例把凭据存进了保险库，而登录这个实例用的是它自己那份**过期**的
   * 会话快照 —— 里面根本没有刚注册的凭据。表现就是「注册明明成功了，
   * 登录却说没有可用的 passkey」。
   *
   * 一次断言本来就要做密码学运算、而且由用户点击触发，多一次同步不心疼；
   * 拿过期数据去匹配的代价则是这个功能完全不可用。
   */
  await deps.refresh();
  const candidates: Candidate[] = pickCredentials(deps.items(), rpId, payload.allowCredentials);
  if (candidates.length === 0) {
    // 用户只看一句话，但排查时需要知道「是库里没有，还是页面指定的 id 对不上」
    const inVault = deps.items().flatMap((i) => i.login?.fido2Credentials ?? [])
      .filter((c) => c.rpId === rpId).map((c) => c.credentialId);
    console.warn('[coffer] passkey 无候选：库里 ' + inVault.length + ' 条 [' + inVault.join(',') + ']'
      + '，页面指定 ' + (payload.allowCredentials === null ? '（未限定）'
        : payload.allowCredentials.length + ' 个 [' + payload.allowCredentials.map((a) => a.id).join(',') + ']'));
    return fail(`保险库里没有可用于 ${relyingPartyOf({ rpId })} 的 passkey`);
  }
  const chosen = candidates[0]!;

  const clientData = buildClientData('webauthn.get', payload.challenge, origin);
  const check = checkClientData(clientData, 'webauthn.get', origin);
  if (!check.ok) return fail(`内部校验失败：${check.reason}`);

  // ⚠️ assertPasskey 会**就地自增** chosen.stored.counter。
  // 保险库已解锁 = 用户已验证过自己，因此 UV 置位。
  const assertion = await assertPasskey({
    stored: chosen.stored,
    clientDataJSON: clientData,
    userVerified: true,
  });

  // 计数必须落盘：RP 靠它检测同一个凭据被复制到两台设备。
  // 不存的话它永远停在 0，本地一切正常，只有在开了克隆检测的站点上才被拦。
  await deps.persist([{
    ...chosen.item,
    login: {
      ...chosen.item.login!,
      fido2Credentials: chosen.item.login!.fido2Credentials.map((c) =>
        c.credentialId === chosen.stored.credentialId ? { ...c, counter: chosen.stored.counter } : c),
    },
  }]);

  return {
    ok: true,
    credentialId: chosen.stored.credentialId,
    clientDataJSON: toBase64Url(clientData),
    authenticatorData: toBase64Url(assertion.authenticatorData),
    signature: toBase64Url(assertion.signature),
    userHandle: chosen.stored.userHandle ?? null,
  };
}

/** 已经有同一 rpId 凭据的条目 → URL 匹配的唯一一条 → 都没有就 null（新建） */
function findTarget(items: readonly VaultItem[], rpId: string, origin: string): VaultItem | null {
  const live = items.filter((i) => i.deletedAt === null && i.login !== null);

  const sameRp = live.find((i) => i.login!.fido2Credentials.some((c) => c.rpId === rpId));
  if (sameRp) return sameRp;

  const host = hostOf(origin);
  const byUrl = live.filter((i) => i.login!.uris.some((u) => {
    try { return new URL(u.uri).hostname.toLowerCase() === host; } catch { return false; }
  }));
  // 只有唯一一条时才自动挂上去 —— 有多条就不猜，新建一条更安全
  return byUrl.length === 1 ? byUrl[0]! : null;
}

function newPasskeyItem(
  rpId: string, userName: string | null, origin: string, stored: StoredPasskey,
): VaultItem {
  return {
    id: '', type: 'login', rawType: 1, name: rpId, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: {
      username: userName, password: null, totp: null,
      uris: [{ uri: origin, match: null }],
      passwordRevisionDate: null,
      fido2Credentials: [stored],
    },
    card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

/**
 * 同一个 rpId 的 create **串行**执行。
 *
 * ## 为什么
 *
 * 观察到的现象：页面只调了一次 create，它却执行了两次。第二次读到的是
 * **过期快照**（该条目的凭据列表还是空的），写回去就把第一次刚存的凭据
 * 覆盖掉了 —— 用户看到「注册成功」，下次登录却被告知没有可用的 passkey，
 * 而 create 返回给页面的那个 ID 在库里根本不存在。
 *
 * ## 为什么串行化能修
 *
 * 根因尚未确证（已排除：重发、content script 的转发去重、SW 的请求幂等、
 * 拦截脚本重复求值、base64 编解码）。但无论第二次是怎么来的，
 * 串行化都让第二个**一定在第一个落盘并刷新会话之后**才读 ——
 * 于是它读到的是最新的列表，追加而不是覆盖。
 *
 * 代价从「静默丢一条凭据」变成「可能多一条重复凭据（用户能删）」。
 * 这个交换在任何情况下都划算。
 */
const createLocks = new Map<string, Promise<unknown>>();

export function serializeCreate<T>(rpId: string, run: () => Promise<T>): Promise<T> {
  // 前一个无论成功失败都要放行下一个 —— 一次失败不该把这个站点的注册永久卡死
  const prev = createLocks.get(rpId) ?? Promise.resolve();
  const next = prev.then(run, run);
  // 只留一个「尾巴」用于排队；失败不能变成未处理的拒绝
  const tail = next.then(() => undefined, () => undefined);
  createLocks.set(rpId, tail);
  // 队列排空后清掉，别让这张表随着访问过的站点无限长
  void tail.then(() => { if (createLocks.get(rpId) === tail) createLocks.delete(rpId); });
  return next;
}

export async function handleWebauthn(
  payload: WebauthnPayload | undefined,
  senderOrigin: string | undefined,
  deps: WebauthnDeps,
): Promise<Record<string, unknown>> {
  // ⚠️ 没有 sender.origin 就没有信任根。宁可整个功能不工作，也不能退回到
  // 「相信页面自称的 origin」—— 那正是攻击者想要的。
  if (senderOrigin === undefined) return fail('无法确定页面来源');
  const origin = originOf(senderOrigin);
  if (origin === null) return fail(`不支持的页面来源：${senderOrigin}`);

  if (!payload || typeof payload !== 'object') return fail('请求格式不对');
  // 调用方已经确认过密钥在了 —— 这里不再重复判断。
  // 重复判断会让同一个事实有两个来源，而它们不一致时（比如一边刚被解锁、
  // 另一个还拿着旧状态）报出来的错会指向完全错误的方向。

  try {
    return payload.op === 'create'
      // 同一个 rpId 的注册串行执行 —— 见 serializeCreate 的说明
      ? await serializeCreate(payload.rp.id ?? hostOf(origin), () => handleCreate(payload, origin, deps))
      : await handleGet(payload, origin, deps);
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'passkey 操作失败');
  }
}
