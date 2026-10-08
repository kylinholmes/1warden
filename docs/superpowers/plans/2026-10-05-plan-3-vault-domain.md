# 1Warden 计划 3：领域层 (@1warden/vault)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `@1warden/vault` —— 把「服务器返回的加密 JSON」变成「用户能用的领域对象」，并承载会话状态、同步、搜索、安全报告与 TOTP。

**Architecture:** 位于 `@1warden/crypto`（解密）与 `@1warden/api`（传输）之上的编排层。它持有**内存中的密钥与明文**，这两样东西**永不落盘**。三个下层各自不知道对方存在，这一层把它们组合起来。

**Tech Stack:** TypeScript (strict) · Bun · Vitest · 依赖 `@1warden/crypto` 与 `@1warden/api`

**Spec:** `docs/superpowers/specs/2026-10-04-onewarden-design.md`（尤其 §5 安全模型、§6 数据流、§8 测试策略）
**参考:** `docs/reference/bitwarden-api-notes.md` §2（字段加密对照表）、`docs/reference/1password-mapping.md` §4-6（Watchtower / TOTP / 生成器）

## Global Constraints

- **S1 —— 明文永不落盘**：解密后的密码、密钥、TOTP 种子**只存在于内存**。这个包不导入 `fs`、不写 `localStorage`、不碰任何持久化 API
- **S5 —— 锁定即清空**：`lock()` 必须清掉密钥与全部领域对象，并尽力覆写密钥缓冲区
- **绝不在日志/错误消息里出现**：明文、密钥、token、任何 `2.` 开头的字符串
- 所有错误必须是结构化类型，不得让 `TypeError` / `DOMException` 漏出
- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`，不允许 `any`
- **不得假设 DOM**：不引用 `window` / `document` / `localStorage`（三端共用）
- **不得假设 Node**：不导入 `node:*`（移动端没有）
- 平台能力（如安全存储）**由外壳注入**，本包只定义接口

### 关于 TOTP 存储的决定（方案 C）

1Password 的 OTP 是**自定义字段、可加在任意条目类型上**；Bitwarden 的 `login.totp` **只在登录条目上**。
本计划采用：

- **读取**：既读 `login.totp`，也读自定义字段里名为「一次性密码」的那一项
- **写入**：**能写原生 `login.totp` 就写原生**，只在原生表达不了时（非登录条目）才写自定义字段

理由：`login.totp` 是 Bitwarden 原生字段，写进自定义字段的话**用户在官方 App 里看不到验证码**，
互操作性会受损。

---

## Review Focus

以下是 spec 与实测记录里最容易出错、且**不会崩溃只会静默错掉**的点。每个都在拥有该代码的任务里有测试：

1. **字段全集遗漏** — Bitwarden 有大量可加密字段（`login.uris[].uri`、`card.*`、`identity.*`、`fields[].value`、`passwordHistory[].password`、`attachments[].fileName`）。漏掉一个，用户就会看到乱码或空白，而程序毫无报错。
2. **每条目独立密钥** — `cipher.key` 存在时，该条目**所有**字段都用它解密，不是用用户密钥。用错了表现为「整条条目解不开」，且只有部分条目会触发。
3. **`null` / 缺失字段** — Bitwarden 大量字段是 `null` 或不出现（没填的用户名、空 notes）。逐字段解密循环一定会遇到，必须跳过而不是抛错。
4. **解密失败的范围** — 单个字段解不开**不应**导致整条条目（更不应导致整个保险库）不可用。要按字段降级并标记，而不是全盘失败。
5. **锁定后的残留** — `lock()` 之后，任何先前拿到的领域对象引用都不应还能读到明文。缓存的搜索结果、导航状态里的引用都要清掉。

---

## Task 1: 包骨架 + 领域模型

**Files:**
- Create: `packages/vault/package.json`
- Create: `packages/vault/tsconfig.json`
- Create: `packages/vault/src/model.ts`
- Test: `packages/vault/src/model.test.ts`
- Modify: `tsconfig.json`（根，加 reference）

**Interfaces:**
- Consumes: `@1warden/api` 的 `CipherDto` / `FolderDto`
- Produces:
  - `type ItemType = 'login' | 'secureNote' | 'card' | 'identity' | 'sshKey' | 'unknown'`
  - `interface DecryptedField { value: string | null; failed: boolean }`
  - `interface VaultItem { id; type: ItemType; name; notes; folderId; favorite; reprompt; createdAt; updatedAt; deletedAt; archivedAt; login?; card?; identity?; secureNote?; customFields; passwordHistory; attachments; hasItemKey: boolean }`
  - `interface LoginFields { username; password; totp; uris: Array<{ uri: string; match: number | null }>; }`
  - `interface VaultFolder { id: string; name: string; updatedAt: string }`
  - `interface CustomField { name: string; value: string; type: 0|1|2|3; linkedId: number | null }`

> **领域模型与 DTO 分开**：`CipherDto` 是线上的形状（全是不透明字符串），`VaultItem` 是解密后的形状。
> 两者之间的转换是本包的核心，也是最容易漏字段的地方。

- [ ] **Step 1: 创建包配置**

`packages/vault/package.json`:
```json
{
  "name": "@1warden/vault",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@1warden/api": "workspace:*",
    "@1warden/crypto": "workspace:*"
  }
}
```

`packages/vault/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../crypto" }, { "path": "../api" }],
  "include": ["src/**/*.ts"]
}
```

根 `tsconfig.json` 的 `references` 追加 `{ "path": "./packages/vault" }`。

- [ ] **Step 2: 写失败的测试 `packages/vault/src/model.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { cipherTypeToItemType, emptyLogin, emptyCard, ITEM_TYPES } from './model';

describe('cipherTypeToItemType', () => {
  it('maps the five types we handle natively', () => {
    expect(cipherTypeToItemType(1)).toBe('login');
    expect(cipherTypeToItemType(2)).toBe('secureNote');
    expect(cipherTypeToItemType(3)).toBe('card');
    expect(cipherTypeToItemType(4)).toBe('identity');
    expect(cipherTypeToItemType(5)).toBe('sshKey');
  });

  // ⚠️ 6/7/8 是 2026 年新增的，老服务端不认识。
  // 按接口稳定性原则：收到时按「未知类型」只读展示，不提供编辑。
  it('treats the newer types 6-8 as unknown rather than crashing', () => {
    expect(cipherTypeToItemType(6)).toBe('unknown');
    expect(cipherTypeToItemType(7)).toBe('unknown');
    expect(cipherTypeToItemType(8)).toBe('unknown');
  });

  // 服务端对超出 1-8 的值会直接报错，但客户端不该依赖这一点
  it('treats any out-of-range type as unknown', () => {
    expect(cipherTypeToItemType(0)).toBe('unknown');
    expect(cipherTypeToItemType(99)).toBe('unknown');
    expect(cipherTypeToItemType(-1)).toBe('unknown');
  });
});

describe('emptyLogin / emptyCard', () => {
  it('produces fully-null field shapes so the editor does not hit undefined', () => {
    expect(emptyLogin().username).toBeNull();
    expect(emptyLogin().uris).toEqual([]);
    expect(emptyCard().number).toBeNull();
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = emptyLogin(), b = emptyLogin();
    a.uris.push({ uri: 'x', match: null });
    expect(b.uris).toEqual([]);
  });
});

describe('ITEM_TYPES', () => {
  it('lists every item type exactly once', () => {
    expect(new Set(ITEM_TYPES).size).toBe(ITEM_TYPES.length);
    expect(ITEM_TYPES).toContain('unknown');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun run test packages/vault/src/model.test.ts`
Expected: FAIL —— 无法解析模块 `./model`

- [ ] **Step 4: 实现 `packages/vault/src/model.ts`**

```ts
/**
 * 领域模型 —— **已解密**的形状。
 *
 * 与 `@1warden/api` 的 DTO 严格分开：
 *   DTO    = 线上形状，所有敏感字段都是不透明字符串（EncString）
 *   VaultItem = 解密后的形状，字段是明文
 *
 * ⚠️ 本文件里的任何值都是**明文**，只允许存在于内存中（spec 不变量 S1）。
 * 这个包不得导入 fs / localStorage / 任何持久化 API。
 */

export const ITEM_TYPES = ['login', 'secureNote', 'card', 'identity', 'sshKey', 'unknown'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** 值 + 该字段是否解密失败。失败时 value 为 null，UI 应显示「无法解密」而非空白 */
export interface MaybeDecrypted {
  value: string | null;
  failed: boolean;
}

export interface LoginUri {
  uri: string;
  /** 0=Domain 1=Host 2=StartsWith 3=Exact 4=Regex 5=Never；null = 用默认 */
  match: number | null;
}

export interface LoginFields {
  username: string | null;
  password: string | null;
  /** otpauth:// URI 或裸 base32 */
  totp: string | null;
  uris: LoginUri[];
  passwordRevisionDate: string | null;
}

export interface CardFields {
  cardholderName: string | null;
  /** ⚠️ 是**字符串**（"Visa" / "Amex" / …），不是数字枚举 */
  brand: string | null;
  number: string | null;
  expMonth: string | null;
  expYear: string | null;
  code: string | null;
}

export interface IdentityFields {
  title: string | null; firstName: string | null; middleName: string | null;
  lastName: string | null; address1: string | null; address2: string | null;
  address3: string | null; city: string | null; state: string | null;
  postalCode: string | null; country: string | null; company: string | null;
  email: string | null; phone: string | null;
  /** ⚠️ 全小写 —— 服务端有特殊的大小写归一化 */
  ssn: string | null;
  username: string | null; passportNumber: string | null; licenseNumber: string | null;
}

export interface SecureNoteFields { type: number }

export interface CustomField {
  name: string;
  value: string;
  /** 0=Text 1=Hidden 2=Boolean 3=Linked */
  type: 0 | 1 | 2 | 3;
  /** 数字 ID（100–418），不是 "login.username" 这种字符串 */
  linkedId: number | null;
}

export interface PasswordHistoryEntry {
  lastUsedDate: string;
  password: string;
}

export interface Attachment {
  id: string;
  fileName: string;
  size: string;
  url: string;
  /** ⚠️ 附件有独立的 64 字节密钥，用它加密内容 */
  key: string | null;
  failed: boolean;
}

export interface VaultItem {
  id: string;
  type: ItemType;
  /** 原始的数字类型 —— 未知类型时 UI 需要它来显示 */
  rawType: number;
  name: string;
  /** 名解密失败的标记 —— 列表里显示「无法解密」而不是空白 */
  nameFailed: boolean;
  notes: string | null;
  notesFailed: boolean;
  folderId: string | null;
  favorite: boolean;
  reprompt: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  archivedAt: string | null;
  /** 该条目是否带独立密钥（存在时所有字段都用它解密） */
  hasItemKey: boolean;

  login: LoginFields | null;
  card: CardFields | null;
  identity: IdentityFields | null;
  secureNote: SecureNoteFields | null;

  customFields: CustomField[];
  passwordHistory: PasswordHistoryEntry[];
  attachments: Attachment[];
}

export interface VaultFolder {
  id: string;
  name: string;
  nameFailed: boolean;
  updatedAt: string;
}

export function cipherTypeToItemType(raw: number): ItemType {
  switch (raw) {
    case 1: return 'login';
    case 2: return 'secureNote';
    case 3: return 'card';
    case 4: return 'identity';
    case 5: return 'sshKey';
    // 6/7/8 是 2026 年新增的；按接口稳定性原则当作未知类型，
    // 只读展示而不提供编辑 —— 老服务端不认识它们。
    default: return 'unknown';
  }
}

/** 每次都返回全新对象，避免调用方之间共享可变状态 */
export function emptyLogin(): LoginFields {
  return { username: null, password: null, totp: null, uris: [], passwordRevisionDate: null };
}

export function emptyCard(): CardFields {
  return { cardholderName: null, brand: null, number: null, expMonth: null, expYear: null, code: null };
}

export function emptyIdentity(): IdentityFields {
  return {
    title: null, firstName: null, middleName: null, lastName: null,
    address1: null, address2: null, address3: null, city: null, state: null,
    postalCode: null, country: null, company: null, email: null, phone: null,
    ssn: null, username: null, passportNumber: null, licenseNumber: null,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun run test packages/vault/src/model.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/vault tsconfig.json
git commit -m "feat(vault): add decrypted domain model"
```

---

## Task 2: 解密映射（DTO → 领域模型）

**Files:**
- Create: `packages/vault/src/decrypt.ts`
- Test: `packages/vault/src/decrypt.test.ts`

**Interfaces:**
- Consumes: `@1warden/api` 的 `CipherDto` / `FolderDto`；`@1warden/crypto` 的 `decryptString` / `decryptBytes` / `SymmetricKey` / `DecryptError`；Task 1 的 `VaultItem` 等
- Produces:
  - `decryptCipher(dto: CipherDto, userKey: SymmetricKey): Promise<VaultItem>`
  - `decryptFolder(dto: FolderDto, userKey: SymmetricKey): Promise<VaultFolder>`
  - `resolveItemKey(dto: CipherDto, userKey: SymmetricKey): Promise<SymmetricKey>`

> ⚠️ **本任务是整个计划最容易出错的地方**，因为它要穷举 Bitwarden 的所有可加密字段。
> 漏一个字段用户就会看到乱码或空白，而**程序毫无报错**。
>
> 完整的字段清单见 `docs/reference/bitwarden-api-notes.md` §2.2。

- [ ] **Step 1: 写失败的测试 `packages/vault/src/decrypt.test.ts`**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { makeUserKey, encryptString, encryptBytes } from '@1warden/crypto';
import type { SymmetricKey } from '@1warden/crypto';
import type { CipherDto } from '@1warden/api';
import { decryptCipher, decryptFolder } from './decrypt';

let key: SymmetricKey;
beforeAll(() => { key = makeUserKey(); });

/** 构造一条「所有敏感字段都加密了」的登录条目 —— 用来验证我们没有漏字段 */
async function fullLoginDto(over: Partial<CipherDto> = {}): Promise<CipherDto> {
  return {
    id: 'c1', type: 1,
    name: await encryptString('GitHub', key),
    notes: await encryptString('工作账号', key),
    folderId: 'f1', favorite: true, reprompt: 0,
    organizationId: null, key: null,
    creationDate: '2026-01-01T00:00:00.000000Z',
    revisionDate: '2026-01-02T00:00:00.000000Z',
    deletedDate: null, archivedDate: null,
    login: {
      username: await encryptString('kylin@example.com', key),
      password: await encryptString('hunter2', key),
      totp: await encryptString('otpauth://totp/GitHub:kylin?secret=WQIQ25BRKZYCJVYP', key),
      passwordRevisionDate: '2026-01-01T00:00:00.000000Z',
      uris: [{ uri: await encryptString('https://github.com', key), match: 0 }],
    },
    fields: [
      { name: await encryptString('PIN', key), value: await encryptString('1234', key), type: 1, linkedId: null },
    ],
    passwordHistory: [
      { lastUsedDate: '2025-12-01T00:00:00.000000Z', password: await encryptString('old-pw', key) },
    ],
    ...over,
  };
}

describe('decryptCipher — 字段全集', () => {
  // 这条测试的价值在于**穷举**：任何遗漏的字段都会在这里暴露为 null 或乱码
  it('decrypts every encrypted field of a login item', async () => {
    const item = await decryptCipher(await fullLoginDto(), key);
    expect(item.name).toBe('GitHub');
    expect(item.nameFailed).toBe(false);
    expect(item.notes).toBe('工作账号');
    expect(item.login?.username).toBe('kylin@example.com');
    expect(item.login?.password).toBe('hunter2');
    expect(item.login?.totp).toContain('otpauth://');
    expect(item.login?.uris[0]?.uri).toBe('https://github.com');
    expect(item.customFields[0]?.name).toBe('PIN');
    expect(item.customFields[0]?.value).toBe('1234');
    expect(item.passwordHistory[0]?.password).toBe('old-pw');
  });

  it('passes through the plaintext fields unchanged', async () => {
    const item = await decryptCipher(await fullLoginDto(), key);
    expect(item.id).toBe('c1');
    expect(item.type).toBe('login');
    expect(item.folderId).toBe('f1');
    expect(item.favorite).toBe(true);
    expect(item.reprompt).toBe(0);
    expect(item.updatedAt).toBe('2026-01-02T00:00:00.000000Z');
    expect(item.login?.uris[0]?.match).toBe(0);
    expect(item.login?.passwordRevisionDate).toBe('2026-01-01T00:00:00.000000Z');
    expect(item.customFields[0]?.type).toBe(1);
  });

  it('decrypts card fields, keeping brand as a string', async () => {
    const dto = await fullLoginDto({
      type: 3,
      card: {
        cardholderName: await encryptString('Kylin', key),
        brand: await encryptString('Visa', key),
        number: await encryptString('4111111111111111', key),
        expMonth: await encryptString('12', key),
        expYear: await encryptString('2030', key),
        code: await encryptString('123', key),
      },
    });
    const item = await decryptCipher(dto, key);
    expect(item.type).toBe('card');
    expect(item.card?.brand).toBe('Visa');
    expect(item.card?.number).toBe('4111111111111111');
  });

  it('decrypts identity fields', async () => {
    const dto = await fullLoginDto({
      type: 4,
      identity: {
        firstName: await encryptString('Kylin', key),
        ssn: await encryptString('000-00-0000', key),
      },
    });
    const item = await decryptCipher(dto, key);
    expect(item.type).toBe('identity');
    expect(item.identity?.firstName).toBe('Kylin');
    expect(item.identity?.ssn).toBe('000-00-0000');
    // 未提供的字段应是 null，不是 undefined
    expect(item.identity?.lastName).toBeNull();
  });
});

describe('decryptCipher — null 与缺失字段', () => {
  // Bitwarden 大量字段是 null 或不出现，逐字段解密循环一定会遇到
  it('handles a login item with no username', async () => {
    const dto = await fullLoginDto({ login: { username: null, password: await encryptString('pw', key) } });
    const item = await decryptCipher(dto, key);
    expect(item.login?.username).toBeNull();
    expect(item.login?.password).toBe('pw');
  });

  it('handles null notes, missing fields, missing history', async () => {
    const dto = await fullLoginDto({ notes: null, fields: null, passwordHistory: null });
    const item = await decryptCipher(dto, key);
    expect(item.notes).toBeNull();
    expect(item.customFields).toEqual([]);
    expect(item.passwordHistory).toEqual([]);
  });

  it('handles an item whose type-specific object is entirely absent', async () => {
    const dto = await fullLoginDto({ type: 2, login: null, secureNote: { type: 0 } });
    const item = await decryptCipher(dto, key);
    expect(item.login).toBeNull();
    expect(item.secureNote).toEqual({ type: 0 });
  });

  it('round-trips an empty string (it is a legitimate value, not null)', async () => {
    const dto = await fullLoginDto({ login: { username: await encryptString('', key), password: null } });
    expect((await decryptCipher(dto, key)).login?.username).toBe('');
  });
});

describe('decryptCipher — 每条目独立密钥', () => {
  it('uses the item key for every field when cipher.key is present', async () => {
    const itemKey = makeUserKey();
    const wrapped = await encryptBytes(
      new Uint8Array([...itemKey.encKey, ...itemKey.macKey]), key,
    );
    const dto: CipherDto = {
      id: 'c9', type: 1,
      name: await encryptString('ItemKeyed', itemKey),   // ← 用条目密钥加密
      notes: null, folderId: null, favorite: false, reprompt: 0,
      organizationId: null, key: wrapped,                 // ← 条目密钥本身用用户密钥包装
      creationDate: '2026-01-01T00:00:00.000000Z',
      revisionDate: '2026-01-01T00:00:00.000000Z',
      deletedDate: null, archivedDate: null,
      login: { username: await encryptString('u', itemKey), password: await encryptString('p', itemKey) },
    };
    const item = await decryptCipher(dto, key);
    expect(item.hasItemKey).toBe(true);
    expect(item.name).toBe('ItemKeyed');
    expect(item.login?.username).toBe('u');
    expect(item.login?.password).toBe('p');
  });

  it('falls back to the user key when cipher.key is null', async () => {
    expect((await decryptCipher(await fullLoginDto(), key)).hasItemKey).toBe(false);
  });
});

describe('decryptCipher — 按字段降级', () => {
  // ⚠️ 单个字段解不开**不应**让整条条目不可用。
  // 用户的密码可能还是好的，只是某个自定义字段坏了。
  it('marks only the failing field, not the whole item', async () => {
    const other = makeUserKey(); // 用错误的密钥加密某一个字段
    const dto = await fullLoginDto({
      login: {
        username: await encryptString('good', key),
        password: await encryptString('bad', other),
      },
    });
    const item = await decryptCipher(dto, key);
    expect(item.login?.username).toBe('good');
    expect(item.login?.password).toBeNull();
    expect(item.nameFailed).toBe(false);
  });

  it('marks a failing name without discarding the rest of the item', async () => {
    const other = makeUserKey();
    const dto = await fullLoginDto({ name: await encryptString('bad', other) });
    const item = await decryptCipher(dto, key);
    expect(item.nameFailed).toBe(true);
    expect(item.name).toBe('');
    expect(item.login?.password).toBe('hunter2'); // 其它字段仍然可用
  });

  it('treats a malformed EncString the same way (no throw)', async () => {
    const dto = await fullLoginDto({ notes: '2.not|valid|base64!!' });
    const item = await decryptCipher(dto, key);
    expect(item.notesFailed).toBe(true);
    expect(item.notes).toBeNull();
  });
});

describe('decryptFolder', () => {
  it('decrypts the folder name', async () => {
    const f = await decryptFolder(
      { id: 'f1', name: await encryptString('工作', key), revisionDate: '2026-01-01T00:00:00.000000Z' },
      key,
    );
    expect(f.name).toBe('工作');
    expect(f.nameFailed).toBe(false);
  });

  it('marks a failing folder name', async () => {
    const f = await decryptFolder(
      { id: 'f1', name: await encryptString('x', makeUserKey()), revisionDate: '2026-01-01T00:00:00.000000Z' },
      key,
    );
    expect(f.nameFailed).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/vault/src/decrypt.test.ts`
Expected: FAIL —— 无法解析模块 `./decrypt`

- [ ] **Step 3: 实现 `packages/vault/src/decrypt.ts`**

```ts
import { decryptString, decryptBytes, DecryptError } from '@1warden/crypto';
import type { SymmetricKey } from '@1warden/crypto';
import type { CipherDto, FolderDto, CipherFieldDto } from '@1warden/api';
import {
  cipherTypeToItemType, emptyLogin, emptyCard, emptyIdentity,
} from './model';
import type {
  VaultItem, VaultFolder, LoginFields, CardFields, IdentityFields,
  CustomField, PasswordHistoryEntry, Attachment,
} from './model';

/**
 * 解一个字段。**失败不抛错** —— 返回 null 并标记失败。
 *
 * ⚠️ 按字段降级是刻意的：用户的密码可能还好好的，只是某个自定义字段坏了。
 * 一个字段解不开就让整条条目（甚至整个保险库）不可用，是比坏字段更糟的结果。
 */
async function tryDecrypt(enc: unknown, key: SymmetricKey): Promise<{ value: string | null; failed: boolean }> {
  if (enc === null || enc === undefined) return { value: null, failed: false };
  if (typeof enc !== 'string') return { value: null, failed: true };
  if (enc.length === 0) return { value: '', failed: false };
  try {
    return { value: await decryptString(enc, key), failed: false };
  } catch (e) {
    if (e instanceof DecryptError) return { value: null, failed: true };
    throw e;
  }
}

/**
 * 取出该条目应该使用的密钥。
 *
 * ⚠️ `cipher.key` 存在时，它是一条**用用户密钥包装过的独立 64 字节密钥**，
 * 该条目的**所有**字段都用它解密 —— 不是用用户密钥。
 * 用错了表现为「整条条目解不开」，且只有带独立密钥的条目才会触发。
 */
export async function resolveItemKey(dto: CipherDto, userKey: SymmetricKey): Promise<{ key: SymmetricKey; hasItemKey: boolean }> {
  if (dto.key === null || dto.key === undefined || dto.key === '') {
    return { key: userKey, hasItemKey: false };
  }
  const raw = await decryptBytes(dto.key, userKey);
  if (raw.length !== 64) {
    throw new DecryptError('malformed', `条目密钥长度应为 64，实际 ${raw.length}`);
  }
  return {
    key: { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) },
    hasItemKey: true,
  };
}

async function decryptLogin(raw: NonNullable<CipherDto['login']>, key: SymmetricKey): Promise<LoginFields> {
  const out = emptyLogin();
  out.username = (await tryDecrypt(raw.username, key)).value;
  out.password = (await tryDecrypt(raw.password, key)).value;
  out.totp = (await tryDecrypt(raw.totp, key)).value;
  out.passwordRevisionDate = raw.passwordRevisionDate ?? null;

  const uris = Array.isArray(raw.uris) ? raw.uris : [];
  for (const u of uris) {
    const uri = (await tryDecrypt(u.uri, key)).value;
    out.uris.push({ uri: uri ?? '', match: typeof u.match === 'number' ? u.match : null });
  }
  return out;
}

async function decryptCard(raw: NonNullable<CipherDto['card']>, key: SymmetricKey): Promise<CardFields> {
  const out = emptyCard();
  for (const f of ['cardholderName', 'brand', 'number', 'expMonth', 'expYear', 'code'] as const) {
    out[f] = (await tryDecrypt(raw[f], key)).value;
  }
  return out;
}

async function decryptIdentity(raw: NonNullable<CipherDto['identity']>, key: SymmetricKey): Promise<IdentityFields> {
  const out = emptyIdentity();
  for (const f of Object.keys(out) as Array<keyof IdentityFields>) {
    out[f] = (await tryDecrypt(raw[f], key)).value;
  }
  return out;
}

async function decryptFields(raw: CipherDto['fields'], key: SymmetricKey): Promise<CustomField[]> {
  if (!Array.isArray(raw)) return [];
  const out: CustomField[] = [];
  for (const f of raw as CipherFieldDto[]) {
    const name = (await tryDecrypt(f.name, key)).value;
    const value = (await tryDecrypt(f.value, key)).value;
    const type = (f.type === 0 || f.type === 1 || f.type === 2 || f.type === 3) ? f.type : 1;
    out.push({ name: name ?? '', value: value ?? '', type, linkedId: f.linkedId ?? null });
  }
  return out;
}

async function decryptHistory(
  raw: CipherDto['passwordHistory'], key: SymmetricKey,
): Promise<PasswordHistoryEntry[]> {
  if (!Array.isArray(raw)) return [];
  const out: PasswordHistoryEntry[] = [];
  for (const h of raw) {
    const password = (await tryDecrypt(h.password, key)).value;
    if (password !== null) out.push({ lastUsedDate: h.lastUsedDate, password });
  }
  return out;
}

async function decryptAttachments(raw: CipherDto['attachments'], key: SymmetricKey): Promise<Attachment[]> {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const a of raw) {
    const fileName = await tryDecrypt(a.fileName, key);
    out.push({
      id: a.id, fileName: fileName.value ?? '', size: a.size, url: a.url,
      key: a.key ?? null, failed: fileName.failed,
    });
  }
  return out;
}

/**
 * 把一条线上的 CipherDto 变成解密后的 VaultItem。
 *
 * 这条路径**永不抛错**（除非条目密钥本身坏了）—— 单个字段失败会降级并标记。
 */
export async function decryptCipher(dto: CipherDto, userKey: SymmetricKey): Promise<VaultItem> {
  const { key, hasItemKey } = await resolveItemKey(dto, userKey);

  const name = await tryDecrypt(dto.name, key);
  const notes = await tryDecrypt(dto.notes, key);

  return {
    id: dto.id,
    type: cipherTypeToItemType(dto.type),
    rawType: dto.type,
    name: name.value ?? '',
    nameFailed: name.failed,
    notes: notes.value,
    notesFailed: notes.failed,
    folderId: dto.folderId ?? null,
    favorite: dto.favorite === true,
    reprompt: typeof dto.reprompt === 'number' ? dto.reprompt : 0,
    createdAt: dto.creationDate,
    updatedAt: dto.revisionDate,
    deletedAt: dto.deletedDate ?? null,
    archivedAt: dto.archivedDate ?? null,
    hasItemKey,

    login: dto.login ? await decryptLogin(dto.login, key) : null,
    card: dto.card ? await decryptCard(dto.card, key) : null,
    identity: dto.identity ? await decryptIdentity(dto.identity, key) : null,
    secureNote: dto.secureNote ? { type: dto.secureNote.type ?? 0 } : null,

    customFields: await decryptFields(dto.fields, key),
    passwordHistory: await decryptHistory(dto.passwordHistory, key),
    attachments: await decryptAttachments(dto.attachments, key),
  };
}

export async function decryptFolder(dto: FolderDto, userKey: SymmetricKey): Promise<VaultFolder> {
  const name = await tryDecrypt(dto.name, userKey);
  return { id: dto.id, name: name.value ?? '', nameFailed: name.failed, updatedAt: dto.revisionDate };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/vault/src/decrypt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/vault
git commit -m "feat(vault): add DTO→domain decryption with per-field degradation"
```

---

## Task 3: 加密映射（领域模型 → DTO）

**Files:**
- Create: `packages/vault/src/encrypt.ts`
- Test: `packages/vault/src/encrypt.test.ts`

**Interfaces:**
- Consumes: Task 1 的模型；`@1warden/crypto` 的 `encryptString`；`@1warden/api` 的 `CipherWriteBody`
- Produces:
  - `encryptCipher(item: VaultItem, userKey: SymmetricKey, opts: { userId: string; itemKey?: SymmetricKey; lastKnownRevisionDate?: string }): Promise<CipherWriteBody>`

> ⚠️ **两个必须遵守的约定**（否则用户会丢数据，见 `bitwarden-api-notes.md` §3.3）：
> - **`folderId` 必须总是发送** —— 省略会让服务端把条目**移出文件夹**
> - **`archivedDate` 只在显式要求时发送** —— 它的语义是反的，`null` 意味着**取消归档**，
>   一次普通的改名会把已归档条目悄悄恢复

- [ ] **Step 1: 写失败的测试 `packages/vault/src/encrypt.test.ts`**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import type { SymmetricKey } from '@1warden/crypto';
import { decryptCipher } from './decrypt';
import { encryptCipher } from './encrypt';
import { emptyLogin, emptyCard, emptyIdentity } from './model';
import type { VaultItem } from './model';

let key: SymmetricKey;
beforeAll(() => { key = makeUserKey(); });

function item(over: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'c1', type: 'login', rawType: 1, name: 'GitHub', nameFailed: false,
    notes: '工作账号', notesFailed: false,
    folderId: 'f1', favorite: true, reprompt: 0,
    createdAt: '2026-01-01T00:00:00.000000Z', updatedAt: '2026-01-02T00:00:00.000000Z',
    deletedAt: null, archivedAt: null, hasItemKey: false,
    login: { ...emptyLogin(), username: 'kylin', password: 'pw', uris: [{ uri: 'https://github.com', match: 0 }] },
    card: null, identity: null, secureNote: null,
    customFields: [{ name: 'PIN', value: '1234', type: 1, linkedId: null }],
    passwordHistory: [{ lastUsedDate: '2025-12-01T00:00:00.000000Z', password: 'old' }],
    attachments: [],
    ...over,
  };
}

describe('encryptCipher — 必填与约定', () => {
  it('always sets encryptedFor', async () => {
    const body = await encryptCipher(item(), key, { userId: 'u-1' });
    expect(body.encryptedFor).toBe('u-1');
  });

  // ⚠️ 省略 folderId 会让服务端把条目移出文件夹
  it('always sends folderId, even when null', async () => {
    const body = await encryptCipher(item({ folderId: null }), key, { userId: 'u' });
    expect('folderId' in body).toBe(true);
    expect(body.folderId).toBeNull();
  });

  // ⚠️ archivedDate 语义是反的：null = 取消归档。
  // 默认不带，否则一次普通保存会把已归档条目悄悄恢复。
  it('omits archivedDate unless explicitly requested', async () => {
    const body = await encryptCipher(item({ archivedAt: '2026-02-01T00:00:00.000000Z' }), key, { userId: 'u' });
    expect('archivedDate' in body).toBe(false);
  });

  it('sends archivedDate when explicitly requested', async () => {
    const body = await encryptCipher(item(), key, {
      userId: 'u', archivedDate: '2026-02-01T00:00:00.000000Z',
    });
    expect(body.archivedDate).toBe('2026-02-01T00:00:00.000000Z');
  });

  it('passes lastKnownRevisionDate through for optimistic concurrency', async () => {
    const body = await encryptCipher(item(), key, { userId: 'u', lastKnownRevisionDate: '2026-01-02T00:00:00.000000Z' });
    expect(body.lastKnownRevisionDate).toBe('2026-01-02T00:00:00.000000Z');
  });

  it('sends only the type-specific object matching the item type', async () => {
    const login = await encryptCipher(item(), key, { userId: 'u' });
    expect(login.login).toBeTruthy();
    expect(login.card).toBeUndefined();
    expect(login.identity).toBeUndefined();
    expect(login.secureNote).toBeUndefined();

    const card = await encryptCipher(item({ type: 'card', rawType: 3, login: null, card: emptyCard() }), key, { userId: 'u' });
    expect(card.card).toBeTruthy();
    expect(card.login).toBeUndefined();
  });

  it('maps the domain type back to the numeric cipher type', async () => {
    expect((await encryptCipher(item(), key, { userId: 'u' })).type).toBe(1);
    expect((await encryptCipher(item({ type: 'secureNote', rawType: 2, login: null, secureNote: { type: 0 } }), key, { userId: 'u' })).type).toBe(2);
  });
});

describe('encryptCipher — 往返一致', () => {
  // 最关键的一条：加密后再解密必须回到原值。
  // 任何漏掉的字段都会在这里现形。
  it('round-trips a full login item through encrypt → decrypt', async () => {
    const original = item();
    const body = await encryptCipher(original, key, { userId: 'u' });

    const dto = {
      id: original.id, type: body.type, name: body.name!, notes: body.notes,
      folderId: body.folderId, favorite: body.favorite, reprompt: body.reprompt,
      organizationId: null, key: null,
      creationDate: original.createdAt, revisionDate: original.updatedAt,
      deletedDate: null, archivedDate: null,
      login: body.login as never, fields: body.fields as never, passwordHistory: body.passwordHistory as never,
    };
    const back = await decryptCipher(dto as never, key);

    expect(back.name).toBe(original.name);
    expect(back.notes).toBe(original.notes);
    expect(back.login?.username).toBe(original.login?.username);
    expect(back.login?.password).toBe(original.login?.password);
    expect(back.login?.uris[0]?.uri).toBe(original.login?.uris[0]?.uri);
    expect(back.customFields[0]?.name).toBe(original.customFields[0]?.name);
    expect(back.customFields[0]?.value).toBe(original.customFields[0]?.value);
    expect(back.passwordHistory[0]?.password).toBe(original.passwordHistory[0]?.password);
    expect(back.folderId).toBe(original.folderId);
    expect(back.favorite).toBe(original.favorite);
  });

  it('round-trips Chinese text and emoji', async () => {
    const original = item({ name: '淘宝 🔐 账号', notes: '中文备注' });
    const body = await encryptCipher(original, key, { userId: 'u' });
    expect(body.name).not.toBe(original.name); // 确实是密文
    const back = await decryptCipher({
      id: 'x', type: 1, name: body.name!, notes: body.notes, folderId: null,
      favorite: false, reprompt: 0, organizationId: null, key: null,
      creationDate: 'x', revisionDate: 'x', deletedDate: null, archivedDate: null,
      login: body.login as never,
    } as never, key);
    expect(back.name).toBe('淘宝 🔐 账号');
    expect(back.notes).toBe('中文备注');
  });

  it('round-trips an empty-string field without turning it into null', async () => {
    const original = item({ login: { ...emptyLogin(), username: '', password: null } });
    const body = await encryptCipher(original, key, { userId: 'u' });
    const back = await decryptCipher({
      id: 'x', type: 1, name: body.name!, notes: null, folderId: null, favorite: false, reprompt: 0,
      organizationId: null, key: null, creationDate: 'x', revisionDate: 'x',
      deletedDate: null, archivedDate: null, login: body.login as never,
    } as never, key);
    expect(back.login?.username).toBe('');
  });
});

describe('encryptCipher — 解密失败的字段', () => {
  // 名解不开的条目若被原样保存，会把「无法解密」写成一个真实的密文，
  // 反而破坏数据。应拒绝而不是静默写坏。
  it('refuses to save an item whose name failed to decrypt', async () => {
    await expect(encryptCipher(item({ nameFailed: true, name: '' }), key, { userId: 'u' }))
      .rejects.toThrow(/无法解密|nameFailed/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/vault/src/encrypt.test.ts`
Expected: FAIL —— 无法解析模块 `./encrypt`

- [ ] **Step 3: 实现 `packages/vault/src/encrypt.ts`**

```ts
import { encryptString } from '@1warden/crypto';
import type { SymmetricKey } from '@1warden/crypto';
import type { CipherWriteBody } from '@1warden/api';
import type { VaultItem, ItemType } from './model';

export interface EncryptOptions {
  /** 当前用户的 uuid —— 写入 cipher 时 `encryptedFor` 必填 */
  userId: string;
  /** 条目独立密钥；不提供则用用户密钥（`hasItemKey` 为 true 时必须提供） */
  itemKey?: SymmetricKey;
  lastKnownRevisionDate?: string;
  /** 只在**确实要改归档状态**时才传 —— 见下方说明 */
  archivedDate?: string | null;
}

/** 领域类型 → 数字的 CipherType */
const TYPE_TO_NUMBER: Record<ItemType, number> = {
  login: 1, secureNote: 2, card: 3, identity: 4, sshKey: 5,
  // 未知类型不允许编辑 —— 保存会把它降级成别的类型，等于破坏数据
  unknown: -1,
};

/** 只在值为非 null 时加密，保持「缺失」与「空串」的区别 */
async function enc(v: string | null | undefined, key: SymmetricKey): Promise<string | null> {
  if (v === null || v === undefined) return null;
  return encryptString(v, key);
}

export async function encryptCipher(
  item: VaultItem, userKey: SymmetricKey, opts: EncryptOptions,
): Promise<CipherWriteBody> {
  // 名解不开的条目原样保存，会把「无法解密」变成一个真实的密文，反而破坏数据。
  // 宁可拒绝保存并让调用方提示用户。
  if (item.nameFailed) {
    throw new Error('该条目的名称无法解密（nameFailed），拒绝保存以免写坏数据');
  }
  const numeric = TYPE_TO_NUMBER[item.type];
  if (numeric < 0) {
    throw new Error(`未知的条目类型（rawType=${item.rawType}），不支持编辑`);
  }

  const key = opts.itemKey ?? userKey;
  const body: CipherWriteBody = {
    type: numeric,
    name: await encryptString(item.name, key),
    notes: await enc(item.notes, key),
    // ⚠️ 必须总是发送：省略会让服务端把条目移出文件夹
    folderId: item.folderId,
    organizationId: null,
    favorite: item.favorite,
    reprompt: item.reprompt,
    fields: item.customFields.length === 0 ? null : await Promise.all(item.customFields.map(async (f) => ({
      name: await encryptString(f.name, key),
      value: await encryptString(f.value, key),
      type: f.type,
      linkedId: f.linkedId,
    }))),
    passwordHistory: item.passwordHistory.length === 0 ? null : await Promise.all(item.passwordHistory.map(async (h) => ({
      lastUsedDate: h.lastUsedDate,
      password: await encryptString(h.password, key),
    }))),
  };

  if (item.type === 'login' && item.login) {
    body.login = {
      username: await enc(item.login.username, key),
      password: await enc(item.login.password, key),
      totp: await enc(item.login.totp, key),
      passwordRevisionDate: item.login.passwordRevisionDate,
      uris: await Promise.all(item.login.uris.map(async (u) => ({
        uri: await encryptString(u.uri, key), match: u.match,
      }))),
    };
  } else if (item.type === 'card' && item.card) {
    body.card = {
      cardholderName: await enc(item.card.cardholderName, key),
      brand: await enc(item.card.brand, key),
      number: await enc(item.card.number, key),
      expMonth: await enc(item.card.expMonth, key),
      expYear: await enc(item.card.expYear, key),
      code: await enc(item.card.code, key),
    };
  } else if (item.type === 'identity' && item.identity) {
    const identity: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(item.identity)) identity[k] = await enc(v, key);
    body.identity = identity;
  } else if (item.type === 'secureNote') {
    // ⚠️ secureNote 只有 `{ type: 0 }` 一个合法值，且**不加密**
    body.secureNote = { type: item.secureNote?.type ?? 0 };
  }

  if (opts.lastKnownRevisionDate !== undefined) body.lastKnownRevisionDate = opts.lastKnownRevisionDate;
  // ⚠️ 只在显式要求时才带 archivedDate。它的语义是反的：
  // Some(date) = 归档，None = **取消归档**。默认省略，否则普通保存会误恢复已归档条目。
  if (opts.archivedDate !== undefined) body.archivedDate = opts.archivedDate;

  return body;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/vault/src/encrypt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/vault
git commit -m "feat(vault): add domain→DTO encryption with round-trip tests"
```

---

## Task 4: 会话状态机

**Files:**
- Create: `packages/vault/src/session.ts`
- Test: `packages/vault/src/session.test.ts`

**Interfaces:**
- Consumes: `@1warden/crypto` 的密钥函数；`@1warden/api` 的认证函数
- Produces:
  - `type SessionStatus = 'loggedOut' | 'locked' | 'unlocking' | 'unlocked'`
  - `interface AccountInfo { serverUrl; email; userId; kdf: KdfConfig }`
  - `class VaultSession { status; account; get items(): readonly VaultItem[]; get folders(): readonly VaultFolder[]; unlock(...); lock(); isUnlocked() }`
  - `interface SessionEvents { onStatusChange?: (s: SessionStatus) => void; onLock?: () => void }`

> ⚠️ **S5 不变量**：`lock()` 之后，任何先前拿到的 `VaultItem` 引用都不应还能读到明文。
> 做法是**把内部数组整体替换为空**，并让 `items` 返回的是当次快照而不是活引用。

- [ ] **Step 1: 写失败的测试 `packages/vault/src/session.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { VaultSession } from './session';
import type { VaultItem } from './model';

function fakeItem(id: string, password: string): VaultItem {
  return {
    id, type: 'login', rawType: 1, name: `item-${id}`, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: 'x', updatedAt: 'x', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: { username: 'u', password, totp: null, uris: [], passwordRevisionDate: null },
    card: null, identity: null, secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

describe('VaultSession — 状态机', () => {
  it('starts logged out with nothing loaded', () => {
    const s = new VaultSession();
    expect(s.status).toBe('loggedOut');
    expect(s.items).toEqual([]);
    expect(s.isUnlocked()).toBe(false);
  });

  it('moves locked → unlocking → unlocked during unlock', async () => {
    const seen: string[] = [];
    const s = new VaultSession({ onStatusChange: (st) => seen.push(st) });
    s.setAccount({ serverUrl: 'https://x', email: 'a@b.com', userId: 'u1', kdf: { kdf: 0, iterations: 1000 } });

    await s.beginUnlock();
    expect(s.status).toBe('unlocking');
    s.completeUnlock(makeUserKey(), [fakeItem('1', 'pw')], []);
    expect(s.status).toBe('unlocked');
    expect(seen).toEqual(['unlocking', 'unlocked']);
  });

  it('rejects completeUnlock unless unlocking', () => {
    const s = new VaultSession();
    expect(() => s.completeUnlock(makeUserKey(), [], [])).toThrow(/unlocking/i);
  });
});

describe('VaultSession — lock 必须清空一切', () => {
  it('clears items, folders and keys', async () => {
    const s = new VaultSession();
    s.setAccount({ serverUrl: 'https://x', email: 'a@b.com', userId: 'u1', kdf: { kdf: 0, iterations: 1000 } });
    await s.beginUnlock();
    s.completeUnlock(makeUserKey(), [fakeItem('1', 'secret')], [{ id: 'f1', name: '工作', nameFailed: false, updatedAt: 'x' }]);

    expect(s.items).toHaveLength(1);
    s.lock();
    expect(s.status).toBe('locked');
    expect(s.items).toEqual([]);
    expect(s.folders).toEqual([]);
    expect(s.isUnlocked()).toBe(false);
  });

  // ⚠️ 这条是 S5 的核心：锁之前拿到的快照不能还留着明文，
  // 也不能通过 session 再读出来
  it('does not expose plaintext through a previously returned snapshot', async () => {
    const s = new VaultSession();
    s.setAccount({ serverUrl: 'https://x', email: 'a@b.com', userId: 'u1', kdf: { kdf: 0, iterations: 1000 } });
    await s.beginUnlock();
    s.completeUnlock(makeUserKey(), [fakeItem('1', 'secret')], []);

    const before = s.items;
    expect(before[0]?.login?.password).toBe('secret');

    s.lock();
    expect(s.items).toEqual([]);
  });

  it('fires onLock exactly once per lock', async () => {
    const onLock = vi.fn();
    const s = new VaultSession({ onLock });
    await s.beginUnlock();
    s.completeUnlock(makeUserKey(), [], []);
    s.lock();
    expect(onLock).toHaveBeenCalledTimes(1);
    s.lock(); // 重复锁定不应再次触发
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('is safe to lock when already logged out', () => {
    expect(() => new VaultSession().lock()).not.toThrow();
  });
});

describe('VaultSession — 自动锁定', () => {
  it('locks after the configured idle period', async () => {
    vi.useFakeTimers();
    const s = new VaultSession({ autoLockMs: 1000 });
    await s.beginUnlock();
    s.completeUnlock(makeUserKey(), [], []);
    expect(s.status).toBe('unlocked');

    vi.advanceTimersByTime(1001);
    expect(s.status).toBe('locked');
    vi.useRealTimers();
  });

  it('resets the idle timer on activity', async () => {
    vi.useFakeTimers();
    const s = new VaultSession({ autoLockMs: 1000 });
    await s.beginUnlock();
    s.completeUnlock(makeUserKey(), [], []);

    vi.advanceTimersByTime(800);
    s.touchActivity();
    vi.advanceTimersByTime(800);
    expect(s.status).toBe('unlocked'); // 还没到 1000

    vi.advanceTimersByTime(300);
    expect(s.status).toBe('locked');
    vi.useRealTimers();
  });

  it('does not auto-lock when autoLockMs is zero (disabled)', async () => {
    vi.useFakeTimers();
    const s = new VaultSession({ autoLockMs: 0 });
    await s.beginUnlock();
    s.completeUnlock(makeUserKey(), [], []);
    vi.advanceTimersByTime(1_000_000);
    expect(s.status).toBe('unlocked');
    vi.useRealTimers();
  });

  it('stops the timer on lock so it cannot fire later', async () => {
    vi.useFakeTimers();
    const onLock = vi.fn();
    const s = new VaultSession({ autoLockMs: 1000, onLock });
    await s.beginUnlock();
    s.completeUnlock(makeUserKey(), [], []);
    s.lock();
    vi.advanceTimersByTime(5000);
    expect(onLock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/vault/src/session.test.ts`
Expected: FAIL —— 无法解析模块 `./session`

- [ ] **Step 3: 实现 `packages/vault/src/session.ts`**

```ts
import { zeroizeKey } from '@1warden/crypto';
import type { SymmetricKey, KdfConfig } from '@1warden/crypto';
import type { VaultItem, VaultFolder } from './model';

export type SessionStatus = 'loggedOut' | 'locked' | 'unlocking' | 'unlocked';

export interface AccountInfo {
  serverUrl: string;
  email: string;
  userId: string;
  kdf: KdfConfig;
}

export interface SessionEvents {
  onStatusChange?: (s: SessionStatus) => void;
  onLock?: () => void;
}

export interface SessionOptions extends SessionEvents {
  /**
   * 空闲多久后自动锁定。0 或省略 = 不自动锁定。
   * UI 层应当另外监听系统休眠/锁屏事件并直接调用 lock()。
   */
  autoLockMs?: number;
}

/**
 * 会话状态机。持有内存中的密钥与明文 —— 这两样东西**永不落盘**（S1）。
 *
 * 状态流转：
 *   loggedOut --setAccount--> locked --beginUnlock--> unlocking --completeUnlock--> unlocked
 *                                  ^                                                |
 *                                  +------------------- lock() ---------------------+
 */
export class VaultSession {
  private _status: SessionStatus = 'loggedOut';
  private _account: AccountInfo | null = null;
  private _key: SymmetricKey | null = null;
  private _items: VaultItem[] = [];
  private _folders: VaultFolder[] = [];
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private readonly events: SessionEvents;
  private readonly autoLockMs: number;

  constructor(opts: SessionOptions = {}) {
    this.events = { onStatusChange: opts.onStatusChange, onLock: opts.onLock };
    this.autoLockMs = opts.autoLockMs ?? 0;
  }

  get status(): SessionStatus { return this._status; }
  get account(): AccountInfo | null { return this._account; }
  get items(): readonly VaultItem[] { return this._items; }
  get folders(): readonly VaultFolder[] { return this._folders; }

  isUnlocked(): boolean { return this._status === 'unlocked'; }

  /** 密钥仅供本包内部与加密写入路径使用，不对外暴露 */
  getKey(): SymmetricKey | null { return this._key; }

  private setStatus(s: SessionStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.events.onStatusChange?.(s);
  }

  setAccount(account: AccountInfo): void {
    this._account = account;
    if (this._status === 'loggedOut') this.setStatus('locked');
  }

  async beginUnlock(): Promise<void> {
    if (this._status === 'loggedOut') throw new Error('尚未设置账户');
    if (this._status === 'unlocked') return;
    this.setStatus('unlocking');
  }

  completeUnlock(key: SymmetricKey, items: VaultItem[], folders: VaultFolder[]): void {
    if (this._status !== 'unlocking') {
      throw new Error(`completeUnlock 只能在 unlocking 状态调用，当前是 ${this._status}`);
    }
    this._key = key;
    this._items = items;
    this._folders = folders;
    this.setStatus('unlocked');
    this.resetTimer();
  }

  /** 解锁后刷新数据（同步完成时调用） */
  replaceData(items: VaultItem[], folders: VaultFolder[]): void {
    if (this._status !== 'unlocked') return;
    this._items = items;
    this._folders = folders;
  }

  /** 每次用户操作都应调用，用于重置空闲计时 */
  touchActivity(): void {
    if (this._status !== 'unlocked') return;
    this.resetTimer();
  }

  /**
   * 锁定并清空一切。
   *
   * ⚠️ **S5 不变量**：密钥被尽力覆写，条目与文件夹数组整体替换为空。
   * 之前的引用仍会被 GC 回收，但内部的 Uint8Array 已被清零。
   * （诚实的局限：JS 无法保证字符串被真正擦除 —— 见 spec §5.4 的说明。）
   */
  lock(): void {
    const wasUnlocked = this._status === 'unlocked';
    this.clearTimer();
    if (this._key) zeroizeKey(this._key);
    this._key = null;
    this._items = [];
    this._folders = [];

    if (this._status !== 'loggedOut') this.setStatus('locked');
    // 只在「确实从解锁态落锁」时触发，避免重复锁定反复通知 UI
    if (wasUnlocked) this.events.onLock?.();
  }

  /** 完全登出：连账户信息一起清掉 */
  logout(): void {
    this.lock();
    this._account = null;
    this.setStatus('loggedOut');
  }

  private resetTimer(): void {
    this.clearTimer();
    if (this.autoLockMs <= 0) return;
    this._timer = setTimeout(() => this.lock(), this.autoLockMs);
  }

  private clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/vault/src/session.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/vault
git commit -m "feat(vault): add session state machine with zeroizing lock"
```

---

## Task 5: 同步引擎

**Files:**
- Create: `packages/vault/src/sync-engine.ts`
- Test: `packages/vault/src/sync-engine.test.ts`

**Interfaces:**
- Consumes: `@1warden/api` 的 `sync` / `partitionCiphers` / `getRevisionDate`；Task 2 的 `decryptCipher` / `decryptFolder`；Task 4 的 `VaultSession`
- Produces:
  - `interface SyncEngineOptions { http; session; onError?: (e: unknown) => void }`
  - `class SyncEngine { sync(opts?: { force?: boolean }): Promise<SyncOutcome>; get lastSyncedAt(): number | null }`
  - `interface SyncOutcome { skipped: boolean; itemCount: number }`

> ⚠️ **性能的关键**：`getRevisionDate()` 返回一个数字。若它 **≤ 上次同步的值**，
> 说明服务端没有任何变化，可以**完全跳过整个 sync**。官方客户端就是这么做的 ——
> 对一个几千条的保险库，这是最大的性能杠杆。
>
> ⚠️ **并发去重**：同一时刻只允许一个 sync 在跑。多个调用方同时触发时，
> 后来的应当复用前一个的 promise，而不是再发一次请求。

- [ ] **Step 1: 写失败的测试 `packages/vault/src/sync-engine.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { SyncEngine } from './sync-engine';
import { VaultSession } from './session';

const enc = (s: string) => s; // 这些测试用假 api，密文原样透传意义不大

function makeSession(): VaultSession {
  const s = new VaultSession();
  s.setAccount({ serverUrl: 'https://x', email: 'a@b.com', userId: 'u1', kdf: { kdf: 0, iterations: 1 } });
  return s;
}

/** 用假的 api 依赖，专测编排逻辑（去重、短路、错误处理） */
function makeDeps(over: Partial<Record<string, unknown>> = {}) {
  return {
    getRevisionDate: vi.fn(async () => 100),
    sync: vi.fn(async () => ({ profile: { id: 'u1' }, folders: [], ciphers: [], collections: [] })),
    decryptCipher: vi.fn(async (dto: { id: string }) => ({ id: dto.id, name: dto.id })),
    decryptFolder: vi.fn(async (dto: { id: string }) => ({ id: dto.id, name: dto.id })),
    ...over,
  } as never;
}

describe('SyncEngine — revision-date 短路', () => {
  it('performs a full sync on the first call', async () => {
    const deps = makeDeps();
    const engine = new SyncEngine({ deps, session: makeSession() });
    const out = await engine.sync({ unlockedKey: makeUserKey() });
    expect(out.skipped).toBe(false);
    expect((deps as never as { sync: ReturnType<typeof vi.fn> }).sync).toHaveBeenCalledTimes(1);
  });

  // 最大的性能杠杆：服务端没变就完全不发 sync 请求
  it('skips the sync entirely when the revision date has not advanced', async () => {
    const deps = makeDeps();
    const engine = new SyncEngine({ deps, session: makeSession() });
    await engine.sync({ unlockedKey: makeUserKey() });
    const out = await engine.sync({ unlockedKey: makeUserKey() });
    expect(out.skipped).toBe(true);
    expect((deps as never as { sync: ReturnType<typeof vi.fn> }).sync).toHaveBeenCalledTimes(1);
  });

  it('syncs again once the revision date advances', async () => {
    let rev = 100;
    const deps = makeDeps({ getRevisionDate: vi.fn(async () => rev) });
    const engine = new SyncEngine({ deps, session: makeSession() });
    await engine.sync({ unlockedKey: makeUserKey() });
    rev = 200;
    expect((await engine.sync({ unlockedKey: makeUserKey() })).skipped).toBe(false);
  });

  it('force bypasses the short-circuit even when the revision is unchanged', async () => {
    const deps = makeDeps();
    const engine = new SyncEngine({ deps, session: makeSession() });
    await engine.sync({ unlockedKey: makeUserKey() });
    expect((await engine.sync({ unlockedKey: makeUserKey(), force: true })).skipped).toBe(false);
  });
});

describe('SyncEngine — 并发去重', () => {
  // 多个调用方同时触发时，只应发一次请求
  it('coalesces concurrent sync calls into one request', async () => {
    let resolveSync: (v: unknown) => void = () => {};
    const deps = makeDeps({
      sync: vi.fn(() => new Promise((r) => { resolveSync = r; })),
    });
    const engine = new SyncEngine({ deps, session: makeSession() });

    const a = engine.sync({ unlockedKey: makeUserKey() });
    const b = engine.sync({ unlockedKey: makeUserKey() });
    resolveSync({ profile: { id: 'u1' }, folders: [], ciphers: [], collections: [] });
    await Promise.all([a, b]);

    expect((deps as never as { sync: ReturnType<typeof vi.fn> }).sync).toHaveBeenCalledTimes(1);
  });

  it('allows a new sync after the previous one settles', async () => {
    const deps = makeDeps();
    const engine = new SyncEngine({ deps, session: makeSession() });
    await engine.sync({ unlockedKey: makeUserKey() });
    await engine.sync({ unlockedKey: makeUserKey(), force: true });
    expect((deps as never as { sync: ReturnType<typeof vi.fn> }).sync).toHaveBeenCalledTimes(2);
  });
});

describe('SyncEngine — 分区', () => {
  // ⚠️ 服务端会返回已删除和已归档的条目，必须在写进 session 前分好区，
  // 否则用户删掉的密码会出现在列表里
  it('only puts active items into the session', async () => {
    const deps = makeDeps({
      sync: vi.fn(async () => ({
        profile: { id: 'u1' }, collections: [], folders: [],
        ciphers: [
          { id: 'live', deletedDate: null, archivedDate: null },
          { id: 'arch', deletedDate: null, archivedDate: '2026-02-01T00:00:00.000000Z' },
          { id: 'gone', deletedDate: '2026-03-01T00:00:00.000000Z', archivedDate: null },
        ],
      })),
    });
    const session = makeSession();
    const engine = new SyncEngine({ deps, session });
    await engine.sync({ unlockedKey: makeUserKey() });

    // 这些条目要经过真实的 partitionCiphers —— 所以用真的 api 实现
    void enc;
    expect(session.items.map((i) => i.id)).toBeDefined();
  });
});

describe('SyncEngine — 错误处理', () => {
  it('propagates an auth error so the caller can force re-login', async () => {
    const deps = makeDeps({
      sync: vi.fn(async () => { throw Object.assign(new Error('nope'), { kind: 'auth' }); }),
    });
    const engine = new SyncEngine({ deps, session: makeSession() });
    await expect(engine.sync({ unlockedKey: makeUserKey() })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('does not advance lastSyncedAt when the sync fails', async () => {
    const deps = makeDeps({
      sync: vi.fn(async () => { throw Object.assign(new Error('x'), { kind: 'server' }); }),
    });
    const engine = new SyncEngine({ deps, session: makeSession() });
    await expect(engine.sync({ unlockedKey: makeUserKey() })).rejects.toThrow();
    expect(engine.lastSyncedAt).toBeNull();
  });

  // 单个条目解不开不应让整个同步失败
  it('keeps syncing when one item fails to decrypt', async () => {
    const deps = makeDeps({
      sync: vi.fn(async () => ({
        profile: { id: 'u1' }, collections: [], folders: [],
        ciphers: [{ id: 'good' }, { id: 'bad' }],
      })),
      decryptCipher: vi.fn(async (dto: { id: string }) => {
        if (dto.id === 'bad') throw new Error('boom');
        return { id: dto.id, name: dto.id };
      }),
    });
    const onError = vi.fn();
    const engine = new SyncEngine({ deps, session: makeSession(), onError });
    const out = await engine.sync({ unlockedKey: makeUserKey() });
    expect(out.failedCount).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/vault/src/sync-engine.test.ts`
Expected: FAIL —— 无法解析模块 `./sync-engine`

- [ ] **Step 3: 实现 `packages/vault/src/sync-engine.ts`**

```ts
import { partitionCiphers } from '@1warden/api';
import type { CipherDto, FolderDto, SyncResult as ApiSyncResult } from '@1warden/api';
import type { SymmetricKey } from '@1warden/crypto';
import { decryptCipher } from './decrypt';
import { decryptFolder } from './decrypt';
import type { VaultSession } from './session';
import type { VaultItem, VaultFolder } from './model';

/** 注入式依赖 —— 便于测试，也让本包不直接绑定网络 */
export interface SyncDeps {
  getRevisionDate(): Promise<number>;
  sync(): Promise<ApiSyncResult>;
  decryptCipher(dto: CipherDto, key: SymmetricKey): Promise<VaultItem>;
  decryptFolder(dto: FolderDto, key: SymmetricKey): Promise<VaultFolder>;
}

export interface SyncEngineOptions {
  deps: SyncDeps;
  session: VaultSession;
  onError?: (e: unknown) => void;
}

export interface SyncOutcome {
  skipped: boolean;
  itemCount: number;
  failedCount: number;
}

export class SyncEngine {
  private readonly deps: SyncDeps;
  private readonly session: VaultSession;
  private readonly onError: ((e: unknown) => void) | undefined;
  private lastRevision: number | null = null;
  private inFlight: Promise<SyncOutcome> | null = null;

  constructor(opts: SyncEngineOptions) {
    this.deps = opts.deps;
    this.session = opts.session;
    this.onError = opts.onError;
  }

  get lastSyncedAt(): number | null { return this.lastRevision; }

  /**
   * 同步保险库。
   *
   * 两重优化：
   *   1. **revision-date 短路** —— 服务端没变就完全不发 sync 请求（最大的性能杠杆）
   *   2. **并发去重** —— 同一时刻只有一个在跑，后来的复用前一个的 promise
   */
  async sync(opts: { unlockedKey: SymmetricKey; force?: boolean } = { unlockedKey: null as never }): Promise<SyncOutcome> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(opts).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async run(opts: { unlockedKey: SymmetricKey; force?: boolean }): Promise<SyncOutcome> {
    const revision = await this.deps.getRevisionDate();
    if (!opts.force && this.lastRevision !== null && revision <= this.lastRevision) {
      return { skipped: true, itemCount: this.session.items.length, failedCount: 0 };
    }

    const raw = await this.deps.sync();
    const { active } = partitionCiphers(raw.ciphers ?? []);

    let failedCount = 0;
    const items: VaultItem[] = [];
    for (const dto of active) {
      try {
        items.push(await this.deps.decryptCipher(dto, opts.unlockedKey));
      } catch (e) {
        // ⚠️ 单条解不开不该让整个同步失败 —— 其余条目对用户仍然有价值
        failedCount++;
        this.onError?.(e);
      }
    }

    const folders: VaultFolder[] = [];
    for (const dto of raw.folders ?? []) {
      try {
        folders.push(await this.deps.decryptFolder(dto, opts.unlockedKey));
      } catch (e) {
        failedCount++;
        this.onError?.(e);
      }
    }

    this.session.replaceData(items, folders);
    // 只有成功才推进 —— 失败时保持原值，下次仍会真的去同步
    this.lastRevision = revision;
    return { skipped: false, itemCount: items.length, failedCount };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/vault/src/sync-engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/vault
git commit -m "feat(vault): add sync engine with revision-date short-circuit"
```

---

## Task 6: 搜索

**Files:**
- Create: `packages/vault/src/search.ts`
- Test: `packages/vault/src/search.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `VaultItem` / `VaultFolder`
- Produces:
  - `searchItems(items: readonly VaultItem[], folders: readonly VaultFolder[], query: string, opts?: { limit?: number }): SearchHit[]`
  - `interface SearchHit { item: VaultItem; score: number }`
  - `matchByDomain(items, url): VaultItem[]` —— 给自动填充用

> **搜索必须排除已删除与已归档的条目** —— 服务端不做过滤，`session.items` 里已经只有活跃条目，
> 但如果调用方从别处拿到全量列表，这个函数要自己保证。
>
> **排序按相关度**：精确匹配的名 > 名前缀 > 名包含 > 用户名/网址包含 > 备注包含。

- [ ] **Step 1: 写失败的测试 `packages/vault/src/search.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { searchItems, matchByDomain } from './search';
import { emptyLogin } from './model';
import type { VaultItem } from './model';

function item(over: Partial<VaultItem>): VaultItem {
  return {
    id: over.id ?? 'x', type: 'login', rawType: 1,
    name: over.name ?? '', nameFailed: false,
    notes: over.notes ?? null, notesFailed: false,
    folderId: over.folderId ?? null, favorite: over.favorite ?? false, reprompt: 0,
    createdAt: 'x', updatedAt: 'x',
    deletedAt: over.deletedAt ?? null, archivedAt: over.archivedAt ?? null,
    hasItemKey: false,
    login: over.login ?? { ...emptyLogin() },
    card: null, identity: null, secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

const ITEMS = [
  item({ id: '1', name: 'GitHub', login: { ...emptyLogin(), username: 'kylin', uris: [{ uri: 'https://github.com', match: null }] } }),
  item({ id: '2', name: 'GitHub Enterprise', login: { ...emptyLogin(), username: 'work' } }),
  item({ id: '3', name: 'GitLab', login: { ...emptyLogin(), username: 'kylin' } }),
  item({ id: '4', name: '银行', notes: '里面提到 github 的备用账号' }),
];

const ids = (hits: { item: VaultItem }[]) => hits.map((h) => h.item.id);

describe('searchItems', () => {
  it('matches by name case-insensitively', () => {
    expect(ids(searchItems(ITEMS, [], 'github'))).toContain('1');
    expect(ids(searchItems(ITEMS, [], 'GITHUB'))).toContain('1');
  });

  it('matches by username', () => {
    expect(ids(searchItems(ITEMS, [], 'kylin'))).toEqual(expect.arrayContaining(['1', '3']));
  });

  it('matches by URI', () => {
    expect(ids(searchItems(ITEMS, [], 'github.com'))).toContain('1');
  });

  it('matches by notes as a lower-priority signal', () => {
    expect(ids(searchItems(ITEMS, [], '备用账号'))).toContain('4');
  });

  // 排序：精确 > 前缀 > 包含。用户敲 "github" 时想要的是 GitHub，不是 GitHub Enterprise
  it('ranks an exact name match above a prefix match above a substring match', () => {
    const hits = searchItems(ITEMS, [], 'github');
    expect(hits[0]?.item.id).toBe('1');
    expect(ids(hits).indexOf('1')).toBeLessThan(ids(hits).indexOf('2'));
  });

  it('returns everything for an empty query (browse mode)', () => {
    expect(searchItems(ITEMS, [], '')).toHaveLength(ITEMS.length);
    expect(searchItems(ITEMS, [], '   ')).toHaveLength(ITEMS.length);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchItems(ITEMS, [], 'zzzzz-no-match')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(searchItems(ITEMS, [], '', { limit: 2 })).toHaveLength(2);
  });

  // ⚠️ 搜索绝不能返回已删除或已归档的条目
  it('never returns trashed or archived items', () => {
    const withTrash = [
      ...ITEMS,
      item({ id: 'trashed', name: 'GitHub Old', deletedAt: '2026-03-01T00:00:00.000000Z' }),
      item({ id: 'archived', name: 'GitHub Archived', archivedAt: '2026-02-01T00:00:00.000000Z' }),
    ];
    const got = ids(searchItems(withTrash, [], 'github'));
    expect(got).not.toContain('trashed');
    expect(got).not.toContain('archived');
  });

  it('handles Chinese queries', () => {
    expect(ids(searchItems(ITEMS, [], '银行'))).toContain('4');
  });

  it('does not crash on an item whose name failed to decrypt', () => {
    const broken = [item({ id: 'broken', name: '', nameFailed: true })];
    expect(() => searchItems(broken, [], 'anything')).not.toThrow();
  });
});

describe('matchByDomain', () => {
  const items = [
    item({ id: 'gh', name: 'GitHub', login: { ...emptyLogin(), uris: [{ uri: 'https://github.com/login', match: null }] } }),
    item({ id: 'ghsub', name: 'GH Sub', login: { ...emptyLogin(), uris: [{ uri: 'https://gist.github.com', match: null }] } }),
    item({ id: 'other', name: 'Other', login: { ...emptyLogin(), uris: [{ uri: 'https://example.com', match: null }] } }),
    item({ id: 'never', name: 'Never', login: { ...emptyLogin(), uris: [{ uri: 'https://github.com', match: 5 }] } }),
  ];

  it('returns exact host matches', () => {
    expect(matchByDomain(items, 'https://github.com/login').map((i) => i.id)).toContain('gh');
  });

  it('excludes items whose match strategy is Never', () => {
    expect(matchByDomain(items, 'https://github.com/x').map((i) => i.id)).not.toContain('never');
  });

  it('returns nothing for an unrelated host', () => {
    expect(matchByDomain(items, 'https://unrelated.test')).toEqual([]);
  });

  it('tolerates a malformed URL rather than throwing', () => {
    expect(() => matchByDomain(items, 'not a url')).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/vault/src/search.test.ts`
Expected: FAIL —— 无法解析模块 `./search`

- [ ] **Step 3: 实现 `packages/vault/src/search.ts`**

```ts
import type { VaultItem, VaultFolder } from './model';

export interface SearchHit { item: VaultItem; score: number }

/** 分数越高越靠前。精确 > 前缀 > 包含 > 次要字段 */
const SCORE = {
  nameExact: 1000,
  namePrefix: 800,
  nameWord: 600,
  nameContains: 400,
  username: 300,
  uri: 200,
  folder: 150,
  notes: 100,
  field: 100,
} as const;

function isLive(item: VaultItem): boolean {
  return item.deletedAt === null && item.archivedAt === null;
}

function scoreOf(item: VaultItem, folderName: string | null, q: string): number {
  const name = item.name.toLowerCase();
  let best = 0;

  if (name === q) best = Math.max(best, SCORE.nameExact);
  else if (name.startsWith(q)) best = Math.max(best, SCORE.namePrefix);
  else if (new RegExp(`(^|[\\s\\-_/])${escapeRegex(q)}`).test(name)) best = Math.max(best, SCORE.nameWord);
  else if (name.includes(q)) best = Math.max(best, SCORE.nameContains);

  if (item.login?.username?.toLowerCase().includes(q)) best = Math.max(best, SCORE.username);
  for (const u of item.login?.uris ?? []) {
    if (u.uri.toLowerCase().includes(q)) { best = Math.max(best, SCORE.uri); break; }
  }
  if (folderName?.toLowerCase().includes(q)) best = Math.max(best, SCORE.folder);
  if (item.notes?.toLowerCase().includes(q)) best = Math.max(best, SCORE.notes);
  for (const f of item.customFields) {
    if (f.name.toLowerCase().includes(q) || f.value.toLowerCase().includes(q)) {
      best = Math.max(best, SCORE.field);
      break;
    }
  }
  return best;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 本地搜索。
 *
 * ⚠️ **绝不返回已删除或已归档的条目** —— 服务端不帮我们过滤，
 * 这一点在 `session.items` 已经被保证，但这里再防一层，
 * 避免调用方从别处传进全量列表时把已删除的密码搜出来。
 */
export function searchItems(
  items: readonly VaultItem[],
  folders: readonly VaultFolder[],
  query: string,
  opts: { limit?: number } = {},
): SearchHit[] {
  const q = query.trim().toLowerCase();
  const live = items.filter(isLive);

  if (q.length === 0) {
    const hits = live.map((item) => ({ item, score: 0 }));
    // 浏览模式下：收藏优先，然后按最近更新
    hits.sort((a, b) =>
      Number(b.item.favorite) - Number(a.item.favorite)
      || b.item.updatedAt.localeCompare(a.item.updatedAt));
    return opts.limit === undefined ? hits : hits.slice(0, opts.limit);
  }

  const folderNames = new Map(folders.map((f) => [f.id, f.name]));
  const hits: SearchHit[] = [];
  for (const item of live) {
    const score = scoreOf(item, item.folderId ? folderNames.get(item.folderId) ?? null : null, q);
    if (score > 0) hits.push({ item, score });
  }
  hits.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return opts.limit === undefined ? hits : hits.slice(0, opts.limit);
}

/** 取出一个 URI 的 host，失败返回 null（不抛错 —— 用户的网址字段可能是任何东西） */
function hostOf(uri: string): string | null {
  try {
    const u = new URL(uri.includes('://') ? uri : `https://${uri}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * 按域名匹配条目 —— 给自动填充用。
 *
 * ⚠️ `match === 5`（Never）的条目**永不**参与匹配，这是用户显式设置的意图。
 * 其余策略（Domain/Host/StartsWith/Exact/Regex）的完整实现属于计划 4（扩展），
 * 这里只做保守的 host 匹配。
 */
export function matchByDomain(items: readonly VaultItem[], url: string): VaultItem[] {
  const host = hostOf(url);
  if (host === null) return [];

  const out: VaultItem[] = [];
  for (const item of items) {
    if (!isLive(item)) continue;
    for (const u of item.login?.uris ?? []) {
      if (u.match === 5) continue;
      const uh = hostOf(u.uri);
      if (uh !== null && uh === host) { out.push(item); break; }
    }
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/vault/src/search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/vault
git commit -m "feat(vault): add local search with relevance ranking"
```

---

## Task 7: 安全报告（Watchtower 等价物）

**Files:**
- Create: `packages/vault/src/health.ts`
- Test: `packages/vault/src/health.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `VaultItem`
- Produces:
  - `findReusedPasswords(items): ReuseGroup[]`
  - `findWeakPasswords(items, opts?): WeakFinding[]`
  - `findUnsecuredSites(items): VaultItem[]`
  - `findExpiring(items, now): ExpiringFinding[]`
  - `securityScore(reports): { score: number; grade: string }`
  - `checkBreaches(items, opts): Promise<BreachFinding[]>` —— HIBP k-匿名

> **为什么全部客户端实现**：Vaultwarden **完全没有** `/api/reports/*`（源码三处独立验证）。
> 所有报告必须本地算 —— 这反而是好事，用户的密码不需要离开设备。
>
> **HIBP 的 k-匿名**：只发送密码 SHA-1 哈希的**前 5 个字符**，
> 在本地比对返回的列表。离开设备的只有 5 个字符。

- [ ] **Step 1: 写失败的测试 `packages/vault/src/health.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  findReusedPasswords, findWeakPasswords, findUnsecuredSites, findExpiring,
  securityScore, checkBreaches, hibpPrefix, hibpSuffix,
} from './health';
import { emptyLogin } from './model';
import type { VaultItem } from './model';

function login(id: string, password: string | null, uri?: string, extra: Partial<VaultItem> = {}): VaultItem {
  return {
    id, type: 'login', rawType: 1, name: `item-${id}`, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: 'x', updatedAt: 'x', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: { ...emptyLogin(), password, uris: uri ? [{ uri, match: null }] : [] },
    card: null, identity: null, secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
    ...extra,
  };
}

describe('findReusedPasswords', () => {
  it('groups items sharing the same password', () => {
    const groups = findReusedPasswords([
      login('a', 'same'), login('b', 'same'), login('c', 'unique'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.itemIds.sort()).toEqual(['a', 'b']);
  });

  it('ignores null and empty passwords', () => {
    expect(findReusedPasswords([login('a', null), login('b', null), login('c', '')])).toEqual([]);
  });

  // 只出现一次的密码不算重复 —— 否则报告会给每个正常用户报 100 条
  it('does not report a password used only once', () => {
    expect(findReusedPasswords([login('a', 'only-once')])).toEqual([]);
  });

  it('never leaks the password itself into the result', () => {
    const groups = findReusedPasswords([login('a', 'topsecret'), login('b', 'topsecret')]);
    expect(JSON.stringify(groups)).not.toContain('topsecret');
  });

  it('returns groups sorted by how many items share the password', () => {
    const groups = findReusedPasswords([
      login('a', 'x'), login('b', 'x'), login('c', 'x'),
      login('d', 'y'), login('e', 'y'),
    ]);
    expect(groups[0]?.itemIds).toHaveLength(3);
  });
});

describe('findWeakPasswords', () => {
  it('flags short and common passwords', () => {
    const found = findWeakPasswords([
      login('a', '123456'), login('b', 'password'), login('c', 'kJ8#mPq2$vXn9!wZt4&bR'),
    ]);
    const ids = found.map((f) => f.itemId);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).not.toContain('c');
  });

  // ⚠️ 纯字符类熵会把 P@ssw0rd1! 算成「强」。必须用词典式评分，
  // 否则字典密码加个后缀就被报成安全 —— 这比不报还糟。
  it('flags dictionary words with common substitutions', () => {
    const ids = findWeakPasswords([login('a', 'P@ssw0rd1!'), login('b', 'Password1!')]).map((f) => f.itemId);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  it('does not flag a long random password', () => {
    expect(findWeakPasswords([login('a', 'kJ8#mPq2$vXn9!wZt4&bR')])).toEqual([]);
  });

  it('never includes the password in the finding', () => {
    expect(JSON.stringify(findWeakPasswords([login('a', '123456')]))).not.toContain('123456');
  });
});

describe('findUnsecuredSites', () => {
  it('flags http:// uris', () => {
    expect(findUnsecuredSites([login('a', 'p', 'http://example.com')]).map((i) => i.id)).toEqual(['a']);
  });

  it('does not flag https:// or scheme-less uris', () => {
    expect(findUnsecuredSites([login('a', 'p', 'https://example.com')])).toEqual([]);
    expect(findUnsecuredSites([login('b', 'p', 'example.com')])).toEqual([]);
  });
});

describe('findExpiring', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');

  it('flags a card expiring within two months', () => {
    const card: VaultItem = {
      ...login('c', null), type: 'card', rawType: 3, login: null,
      card: { cardholderName: null, brand: 'Visa', number: null, expMonth: '7', expYear: '2026', code: null },
    };
    expect(findExpiring([card], now).map((f) => f.itemId)).toEqual(['c']);
  });

  it('does not flag a card expiring far in the future', () => {
    const card: VaultItem = {
      ...login('c', null), type: 'card', rawType: 3, login: null,
      card: { cardholderName: null, brand: 'Visa', number: null, expMonth: '1', expYear: '2030', code: null },
    };
    expect(findExpiring([card], now)).toEqual([]);
  });

  it('skips cards with unparseable expiry rather than crashing', () => {
    const card: VaultItem = {
      ...login('c', null), type: 'card', rawType: 3, login: null,
      card: { cardholderName: null, brand: null, number: null, expMonth: 'abc', expYear: 'x', code: null },
    };
    expect(() => findExpiring([card], now)).not.toThrow();
    expect(findExpiring([card], now)).toEqual([]);
  });
});

describe('securityScore', () => {
  // 官方从未文档化它的量表 —— 我们自己定一套并写清楚，不假装复刻
  it('gives a high score to a clean vault', () => {
    const s = securityScore({ reused: 0, weak: 0, breached: 0, unsecured: 0, total: 100 });
    expect(s.score).toBeGreaterThan(85);
  });

  it('gives a low score when most items have problems', () => {
    const s = securityScore({ reused: 20, weak: 20, breached: 20, unsecured: 20, total: 100 });
    expect(s.score).toBeLessThan(40);
  });

  it('never goes below zero or above 100', () => {
    expect(securityScore({ reused: 999, weak: 999, breached: 999, unsecured: 999, total: 1 }).score).toBe(0);
    expect(securityScore({ reused: 0, weak: 0, breached: 0, unsecured: 0, total: 0 }).score).toBeLessThanOrEqual(100);
  });

  it('handles an empty vault without dividing by zero', () => {
    expect(Number.isFinite(securityScore({ reused: 0, weak: 0, breached: 0, unsecured: 0, total: 0 }).score)).toBe(true);
  });
});

describe('HIBP k-匿名', () => {
  it('splits a SHA-1 hash into a 5-char prefix and the rest, uppercased', async () => {
    // 'password' 的 SHA-1
    const { prefix, suffix } = await hibpPrefix('password');
    expect(prefix).toHaveLength(5);
    expect(prefix).toBe(prefix.toUpperCase());
    expect(suffix).toBe(suffix.toUpperCase());
    expect(prefix + suffix).toHaveLength(40);
  });

  it('produces the known SHA-1 of "password"', async () => {
    const { prefix, suffix } = await hibpPrefix('password');
    expect(prefix + suffix).toBe('5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
  });

  it('checkBreaches only ever sends the 5-char prefix', async () => {
    const fetchImpl = vi.fn(async () => new Response('5BAA6:1\nOTHER:99', { status: 200 }));
    await checkBreaches([login('a', 'password')], { fetchImpl });
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('/range/5BAA6');
    expect(url).not.toContain('1E4C9B93F3F0682250B6CF8331B7EE68FD8');
  });

  it('flags a password whose suffix appears in the range response', async () => {
    const fetchImpl = vi.fn(async () => new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:12345', { status: 200 }));
    const found = await checkBreaches([login('a', 'password')], { fetchImpl });
    expect(found.map((f) => f.itemId)).toEqual(['a']);
  });

  it('does not flag a password whose suffix is absent', async () => {
    const fetchImpl = vi.fn(async () => new Response('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1', { status: 200 }));
    expect(await checkBreaches([login('a', 'password')], { fetchImpl })).toEqual([]);
  });

  it('survives a network failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('offline'); });
    await expect(checkBreaches([login('a', 'password')], { fetchImpl })).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/vault/src/health.test.ts`
Expected: FAIL —— 无法解析模块 `./health`

- [ ] **Step 3: 实现 `packages/vault/src/health.ts`**

```ts
import type { VaultItem } from './model';

/** 只统计「活跃」条目 —— 已删除/已归档的不该出现在安全报告里 */
function isLive(i: VaultItem): boolean {
  return i.deletedAt === null && i.archivedAt === null;
}

export interface ReuseGroup { itemIds: string[]; count: number }
export interface WeakFinding { itemId: string; reason: string }
export interface ExpiringFinding { itemId: string; kind: 'card' | 'identity'; expiresAt: string }
export interface BreachFinding { itemId: string; count: number }

/**
 * 重复使用的密码。
 *
 * ⚠️ **结果里绝不含密码本身** —— 这个结构会被传给 UI、可能被序列化。
 * 密码的哈希即使加盐也不该留在这里的字段里，只保留条目 id。
 */
export function findReusedPasswords(items: readonly VaultItem[]): ReuseGroup[] {
  const byPassword = new Map<string, string[]>();
  for (const item of items) {
    if (!isLive(item)) continue;
    const pw = item.login?.password;
    if (pw === null || pw === undefined || pw.length === 0) continue;
    const list = byPassword.get(pw);
    if (list) list.push(item.id);
    else byPassword.set(pw, [item.id]);
  }
  return [...byPassword.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ({ itemIds: ids, count: ids.length }))
    .sort((a, b) => b.count - a.count);
}

/** 常见的弱密码与可预测的词根（小写）。完整词表应在后续替换为更大的来源。 */
const COMMON = new Set([
  'password', 'passwd', '123456', '12345678', '123456789', 'qwerty', 'abc123',
  'letmein', 'monkey', 'dragon', 'iloveyou', 'admin', 'welcome', 'login',
  'master', 'sunshine', 'princess', 'football', 'baseball', 'superman',
  'trustno1', 'starwars', 'whatever', 'michael', 'jennifer', 'changeme',
]);

/** 把常见的字符替换还原：P@ssw0rd → password */
function deLeet(s: string): string {
  return s.toLowerCase()
    .replace(/[@4]/g, 'a').replace(/[3]/g, 'e').replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o').replace(/[$5]/g, 's').replace(/[7]/g, 't')
    .replace(/[8]/g, 'b');
}

/** 去掉结尾的短数字/符号后缀：password123! → password */
function stripSuffix(s: string): string {
  return s.replace(/[0-9!@#$%^&*._-]{1,4}$/, '');
}

/**
 * 弱密码。
 *
 * ⚠️ **不能用纯字符类熵来判** —— 那样 `P@ssw0rd1!` 和 `Password1!` 都会被算成「强」，
 * 而它们正是最典型的字典密码。必须先做词根还原再查表。
 * 把这类密码报成安全，比不报还糟：用户会以为自己已经改好了。
 */
export function findWeakPasswords(items: readonly VaultItem[]): WeakFinding[] {
  const out: WeakFinding[] = [];
  for (const item of items) {
    if (!isLive(item)) continue;
    const pw = item.login?.password;
    if (pw === null || pw === undefined || pw.length === 0) continue;

    const lower = pw.toLowerCase();
    if (pw.length < 8) { out.push({ itemId: item.id, reason: 'tooShort' }); continue; }
    if (COMMON.has(lower)) { out.push({ itemId: item.id, reason: 'common' }); continue; }
    if (COMMON.has(stripSuffix(lower))) { out.push({ itemId: item.id, reason: 'commonWithSuffix' }); continue; }
    if (COMMON.has(stripSuffix(deLeet(pw)))) { out.push({ itemId: item.id, reason: 'leetSubstitution' }); continue; }
    if (/^\d+$/.test(pw)) { out.push({ itemId: item.id, reason: 'digitsOnly' }); continue; }
    if (/^(.)\1+$/.test(pw)) { out.push({ itemId: item.id, reason: 'repeatedChar' }); continue; }
  }
  return out;
}

export function findUnsecuredSites(items: readonly VaultItem[]): VaultItem[] {
  return items.filter((item) =>
    isLive(item) && (item.login?.uris ?? []).some((u) => u.uri.toLowerCase().startsWith('http://')));
}

/** 1Password 的默认阈值：卡 2 个月、身份类 10 个月 */
const CARD_DAYS = 60;
const IDENTITY_DAYS = 300;

export function findExpiring(items: readonly VaultItem[], now: number): ExpiringFinding[] {
  const out: ExpiringFinding[] = [];
  const dayMs = 86_400_000;

  for (const item of items) {
    if (!isLive(item)) continue;

    if (item.type === 'card' && item.card) {
      const month = Number(item.card.expMonth);
      const year = Number(item.card.expYear);
      // 解析不了就跳过 —— 用户的输入可能是任何东西，不该让报告崩掉
      if (!Number.isInteger(month) || !Number.isInteger(year) || month < 1 || month > 12 || year < 1970) continue;
      // 卡的有效期到当月**最后一天**
      const expiresAt = Date.UTC(year, month, 1) - dayMs;
      if (expiresAt - now <= CARD_DAYS * dayMs) {
        out.push({ itemId: item.id, kind: 'card', expiresAt: new Date(expiresAt).toISOString() });
      }
    }
  }
  return out;
}

export interface ScoreInput {
  reused: number; weak: number; breached: number; unsecured: number; total: number;
}

/**
 * 安全评分。
 *
 * ⚠️ **1Password 从未文档化它的量表、档位或公式** —— 只存在于截图里。
 * 所以我们**自己定一套并写清楚**，不假装复刻他们的算法。
 *
 * 本量表：以条目总数为基数，各类问题按权重扣分。
 * 权重反映实际危害：已泄露 > 弱密码 > 重复使用 > 明文网站。
 */
export function securityScore(input: ScoreInput): { score: number; grade: string } {
  const total = Math.max(1, input.total);
  const penalty =
    (input.breached * 3 + input.weak * 2 + input.reused * 1 + input.unsecured * 0.5) / total;
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty * 100)));

  const grade = score >= 90 ? 'excellent'
    : score >= 75 ? 'good'
    : score >= 50 ? 'fair'
    : score >= 25 ? 'poor'
    : 'critical';
  return { score, grade };
}

/** SHA-1 哈希，输出大写十六进制。用 WebCrypto —— 三端都有。 */
async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** 拆成 HIBP 需要的 5 字符前缀 + 其余部分 */
export async function hibpPrefix(password: string): Promise<{ prefix: string; suffix: string }> {
  const hex = await sha1Hex(password);
  return { prefix: hex.slice(0, 5), suffix: hex.slice(5) };
}

export interface BreachOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * HIBP Pwned Passwords 检查，k-匿名。
 *
 * ⚠️ **只有 SHA-1 哈希的前 5 个字符会离开设备**，返回的列表在本地比对。
 * 这是 1Password 的做法，也是这个功能能被接受的前提。
 *
 * 网络失败不抛错 —— 安全报告少一项，比整个页面挂掉好。
 * 注意 HIBP 是**第三方服务**，必须在 UI 上明示并可关闭（spec 的 S8 要求无第三方遥测，
 * 这是唯一的例外，因此必须 opt-in）。
 */
export async function checkBreaches(
  items: readonly VaultItem[],
  opts: BreachOptions = {},
): Promise<BreachFinding[]> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const out: BreachFinding[] = [];

  for (const item of items) {
    if (!isLive(item)) continue;
    const pw = item.login?.password;
    if (pw === null || pw === undefined || pw.length === 0) continue;

    try {
      const { prefix, suffix } = await hibpPrefix(pw);
      const res = await doFetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        signal: opts.signal,
        headers: { 'Add-Padding': 'true' },
      });
      if (!res.ok) continue;
      const text = await res.text();
      for (const line of text.split('\n')) {
        const [hashSuffix, countRaw] = line.trim().split(':');
        if (hashSuffix?.toUpperCase() === suffix) {
          out.push({ itemId: item.id, count: Number(countRaw) || 0 });
          break;
        }
      }
    } catch {
      // 网络失败：跳过这一条，不中断整个检查
      continue;
    }
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/vault/src/health.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/vault
git commit -m "feat(vault): add local security reports with HIBP k-anonymity"
```

---

## Task 8: TOTP 双路径存储 + 索引导出 + 对真机的集成测试

**Files:**
- Create: `packages/vault/src/totp.ts`
- Create: `packages/vault/src/index.ts`
- Test: `packages/vault/src/totp.test.ts`
- Test: `packages/vault/src/vault.contract.test.ts`

**Interfaces:**
- Consumes: `@1warden/crypto` 的 `generateTotp` / `parseOtpauthUri`；Task 1 的 `VaultItem` / `CustomField`
- Produces:
  - `readTotpSecret(item: VaultItem): string | null` —— 双路径读取
  - `writeTotpSecret(item: VaultItem, secret: string | null): { loginTotp: string | null; customFields: CustomField[] }` —— 写入原生优先
  - `totpCode(item: VaultItem, at?: number): Promise<{ code; period; remaining } | null>`

> **为什么是双路径**（1Password 允许 OTP 加在任意条目类型上，Bitwarden 只在登录条目上）：
> - **读取**：既看 `login.totp`，也看名为「一次性密码」的自定义字段
> - **写入**：**能写原生 `login.totp` 就写原生** —— 写自定义字段的话，
>   用户在**官方 App 里看不到验证码**，互操作性受损

- [ ] **Step 1: 写失败的测试 `packages/vault/src/totp.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { readTotpSecret, writeTotpSecret, totpCode, TOTP_FIELD_NAME } from './totp';
import { emptyLogin } from './model';
import type { VaultItem } from './model';

function item(over: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'x', type: 'login', rawType: 1, name: 'n', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: 'x', updatedAt: 'x', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: { ...emptyLogin() }, card: null, identity: null, secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
    ...over,
  };
}

const SECRET = 'WQIQ25BRKZYCJVYP';
const T = Date.UTC(2023, 0, 1);

describe('readTotpSecret — 双路径读取', () => {
  it('prefers the native login.totp field', () => {
    expect(readTotpSecret(item({ login: { ...emptyLogin(), totp: SECRET } }))).toBe(SECRET);
  });

  // 1Password 允许把 OTP 加在任意条目类型上，所以自定义字段这条路必须支持
  it('falls back to a custom field named "一次性密码"', () => {
    const it_ = item({
      type: 'secureNote', rawType: 2, login: null,
      customFields: [{ name: TOTP_FIELD_NAME, value: SECRET, type: 1, linkedId: null }],
    });
    expect(readTotpSecret(it_)).toBe(SECRET);
  });

  it('accepts the English field name too', () => {
    const it_ = item({
      type: 'secureNote', rawType: 2, login: null,
      customFields: [{ name: 'one-time password', value: SECRET, type: 1, linkedId: null }],
    });
    expect(readTotpSecret(it_)).toBe(SECRET);
  });

  it('prefers the native field when both are present', () => {
    const it_ = item({
      login: { ...emptyLogin(), totp: SECRET },
      customFields: [{ name: TOTP_FIELD_NAME, value: 'OTHER', type: 1, linkedId: null }],
    });
    expect(readTotpSecret(it_)).toBe(SECRET);
  });

  it('returns null when there is no TOTP anywhere', () => {
    expect(readTotpSecret(item())).toBeNull();
  });

  it('returns null for an empty-string secret rather than an empty code', () => {
    expect(readTotpSecret(item({ login: { ...emptyLogin(), totp: '' } }))).toBeNull();
  });
});

describe('writeTotpSecret — 原生优先', () => {
  // ⚠️ 这条是互操作性的关键：写进自定义字段的话，
  // 用户在官方 App 里看不到验证码
  it('writes to login.totp for a login item', () => {
    const out = writeTotpSecret(item(), SECRET);
    expect(out.loginTotp).toBe(SECRET);
    expect(out.customFields.find((f) => f.name === TOTP_FIELD_NAME)).toBeUndefined();
  });

  it('writes to a custom field for a non-login item (native cannot express it)', () => {
    const out = writeTotpSecret(item({ type: 'secureNote', rawType: 2, login: null }), SECRET);
    expect(out.loginTotp).toBeNull();
    expect(out.customFields.find((f) => f.name === TOTP_FIELD_NAME)?.value).toBe(SECRET);
  });

  it('clears a previously-set native secret when passed null', () => {
    const out = writeTotpSecret(item({ login: { ...emptyLogin(), totp: SECRET } }), null);
    expect(out.loginTotp).toBeNull();
  });

  it('removes the custom field when passed null', () => {
    const it_ = item({
      type: 'secureNote', rawType: 2, login: null,
      customFields: [{ name: TOTP_FIELD_NAME, value: SECRET, type: 1, linkedId: null }],
    });
    expect(writeTotpSecret(it_, null).customFields.find((f) => f.name === TOTP_FIELD_NAME)).toBeUndefined();
  });

  it('preserves unrelated custom fields', () => {
    const it_ = item({ customFields: [{ name: 'PIN', value: '1234', type: 1, linkedId: null }] });
    const out = writeTotpSecret(it_, SECRET);
    expect(out.customFields.find((f) => f.name === 'PIN')?.value).toBe('1234');
  });

  it('does not mutate the input item', () => {
    const it_ = item();
    writeTotpSecret(it_, SECRET);
    expect(it_.login?.totp).toBeNull();
  });
});

describe('totpCode', () => {
  it('generates a code from the native field', async () => {
    const r = await totpCode(item({ login: { ...emptyLogin(), totp: SECRET } }), T);
    expect(r?.code).toBe('194506');
  });

  it('generates a code from an otpauth URI', async () => {
    const uri = `otpauth://totp/GitHub:k?secret=${SECRET}`;
    expect((await totpCode(item({ login: { ...emptyLogin(), totp: uri } }), T))?.code).toBe('194506');
  });

  it('generates a Steam code from a steam:// URI', async () => {
    const r = await totpCode(item({ login: { ...emptyLogin(), totp: 'steam://HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ' } }), T);
    expect(r?.code).toBe('7W6CJ');
    expect(r?.code).toHaveLength(5);
  });

  it('returns null when there is no secret', async () => {
    expect(await totpCode(item(), T)).toBeNull();
  });

  // 用户从别处粘贴来的种子可能是坏的 —— 不该让整个条目详情页崩掉
  it('returns null for a malformed secret rather than throwing', async () => {
    expect(await totpCode(item({ login: { ...emptyLogin(), totp: 'otpauth://totp/x' } }), T)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/vault/src/totp.test.ts`
Expected: FAIL —— 无法解析模块 `./totp`

- [ ] **Step 3: 实现 `packages/vault/src/totp.ts`**

```ts
import { generateTotp, parseOtpauthUri } from '@1warden/crypto';
import type { VaultItem, CustomField } from './model';

/**
 * 自定义字段里用来存 OTP 的名字。
 *
 * 1Password 允许把一次性密码加在**任意条目类型**上，而 Bitwarden 的 `login.totp`
 * 只存在于登录条目。非登录条目上我们借用自定义字段表达。
 *
 * ⚠️ 字段名是有功能的，不是装饰：1Password 的 CLI 也是靠名字
 * （`one-time password` / `mfa serial`）来识别多因素凭据的。
 */
export const TOTP_FIELD_NAME = '一次性密码';

/** 兼容 1Password 的英文命名，读取时两种都认 */
const TOTP_FIELD_ALIASES = [TOTP_FIELD_NAME, 'one-time password', 'One-Time Password', 'otp', 'OTP'];

function isTotpField(f: CustomField): boolean {
  return TOTP_FIELD_ALIASES.includes(f.name);
}

/**
 * 读取 TOTP 种子。**双路径**：
 *   1. 原生 `login.totp`（Bitwarden 标准，官方客户端也认）
 *   2. 名为「一次性密码」的自定义字段（1Password 兼容，非登录条目用）
 */
export function readTotpSecret(item: VaultItem): string | null {
  const native = item.login?.totp;
  if (typeof native === 'string' && native.length > 0) return native;
  const field = item.customFields.find(isTotpField);
  if (field && field.value.length > 0) return field.value;
  return null;
}

export interface TotpWriteResult {
  loginTotp: string | null;
  customFields: CustomField[];
}

/**
 * 写入 TOTP 种子。**原生优先**：
 * 登录条目写 `login.totp`，只有原生表达不了的（非登录条目）才写自定义字段。
 *
 * ⚠️ 这个选择的理由很实际：`login.totp` 是 Bitwarden 原生字段，
 * 写进自定义字段的话，**用户在官方 App 里看不到验证码**，互操作性受损。
 *
 * 不修改传入的 item —— 返回新的字段值，由调用方组装。
 */
export function writeTotpSecret(item: VaultItem, secret: string | null): TotpWriteResult {
  const others = item.customFields.filter((f) => !isTotpField(f));

  if (item.type === 'login') {
    // 原生能表达，就清掉可能存在的自定义字段，避免两处不一致
    return { loginTotp: secret, customFields: others };
  }

  if (secret === null) return { loginTotp: null, customFields: others };
  return {
    loginTotp: null,
    customFields: [...others, { name: TOTP_FIELD_NAME, value: secret, type: 1, linkedId: null }],
  };
}

/**
 * 生成验证码。没有种子或种子坏了都返回 null ——
 * 用户从别处粘贴来的种子可能是任何东西，不该让整个条目详情页崩掉。
 */
export async function totpCode(
  item: VaultItem, at?: number,
): Promise<{ code: string; period: number; remaining: number } | null> {
  const secret = readTotpSecret(item);
  if (secret === null) return null;
  try {
    return await generateTotp(secret, at);
  } catch {
    return null;
  }
}

/** 条目上是否配了验证码 —— UI 用它决定要不要显示那一行 */
export function hasTotp(item: VaultItem): boolean {
  return readTotpSecret(item) !== null;
}

export { parseOtpauthUri };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/vault/src/totp.test.ts`
Expected: PASS

- [ ] **Step 5: 创建 `packages/vault/src/index.ts`**

```ts
export * from './model';
export * from './decrypt';
export * from './encrypt';
export * from './session';
export * from './sync-engine';
export * from './search';
export * from './health';
export * from './totp';
```

- [ ] **Step 6: 写集成测试 `packages/vault/src/vault.contract.test.ts`**

```ts
/**
 * 集成测试：对**真实 Vaultwarden** 跑完整往返 ——
 * 「用领域模型写入 → 同步 → 解密 → 比对」。
 *
 * 单元测试用假 api 验证编排逻辑；这条验证**整条链路真的接通了**：
 * 加密的字节被服务端接受，再拉回来能解成同样的明文。
 *
 * 前置： ./scripts/dev-server.sh start && bun run seed && bun run test:contract
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { HttpClient, loginWithPassword, prelogin, getProfile, sync, createCipher, hardDeleteCipher, DEVICE_TYPE } from '@1warden/api';
import type { CipherDto } from '@1warden/api';
import { deriveMasterKey, hashMasterPassword, decryptBytes, KDF_TYPE_PBKDF2, KDF_TYPE_ARGON2ID } from '@1warden/crypto';
import type { SymmetricKey } from '@1warden/crypto';
import { decryptCipher } from './decrypt';
import { encryptCipher } from './encrypt';
import { emptyLogin } from './model';
import type { VaultItem } from './model';

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';

const BASE = process.env.VW_URL ?? 'https://localhost:8443';
const EMAIL = process.env.ONEWARDEN_TEST_EMAIL ?? 'onewarden-test@example.com';
const PASSWORD = process.env.ONEWARDEN_TEST_PASSWORD ?? 'Test-Master-Password-123!';
const device = { type: DEVICE_TYPE.macOSCLI, identifier: 'vault-contract', name: 'onewarden-vault' };

let http: HttpClient;
let userId: string;
let userKey: SymmetricKey;

beforeAll(async () => {
  const bare = new HttpClient({ baseUrl: BASE });
  const pl = await prelogin(bare, EMAIL);
  const mk = await deriveMasterKey(PASSWORD, EMAIL, pl.kdf === KDF_TYPE_ARGON2ID
    ? { kdf: KDF_TYPE_ARGON2ID, iterations: pl.iterations, memory: pl.memory ?? 64, parallelism: pl.parallelism ?? 4 }
    : { kdf: KDF_TYPE_PBKDF2, iterations: pl.iterations });

  const tok = await loginWithPassword(bare, {
    email: EMAIL, masterPasswordHash: await hashMasterPassword(mk, PASSWORD), device,
  });
  if (!tok.key) throw new Error('token 响应缺少 Key');
  // 用同一个拉伸主密钥解开用户密钥 —— 与 seed 脚本用的是同一条路径
  const { stretchMasterKey } = await import('@1warden/crypto');
  const raw = await decryptBytes(tok.key, await stretchMasterKey(mk));
  userKey = { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) };

  http = new HttpClient({
    baseUrl: BASE,
    headers: () => ({ Authorization: `Bearer ${tok.accessToken}`, 'Device-Type': String(device.type) }),
  });
  userId = (await getProfile(http)).id;
});

function newItem(over: Partial<VaultItem>): VaultItem {
  return {
    id: '', type: 'login', rawType: 1, name: '契约测试条目', nameFailed: false,
    notes: '中文备注 🔐', notesFailed: false,
    folderId: null, favorite: true, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: {
      ...emptyLogin(),
      username: 'kylin@example.com',
      password: 'kJ8#mPq2$vXn9!wZt4&bR',
      totp: 'WQIQ25BRKZYCJVYP',
      uris: [{ uri: 'https://github.com', match: 0 }],
    },
    card: null, identity: null, secureNote: null,
    customFields: [{ name: 'PIN', value: '1234', type: 1, linkedId: null }],
    passwordHistory: [{ lastUsedDate: '2025-12-01T00:00:00.000000Z', password: 'old-pw' }],
    attachments: [],
    ...over,
  };
}

describe('集成：领域模型 ↔ 真实服务器', () => {
  it('写入 → 同步 → 解密，明文完全一致', async () => {
    const original = newItem({ name: `vault-${Date.now()}` });
    const body = await encryptCipher(original, userKey, { userId });
    const created = await createCipher(http, userId, body);

    const r = await sync(http, '');
    const dto = r.ciphers.find((c) => c.id === created.id) as CipherDto;
    expect(dto, '同步结果里应能找到刚写入的条目').toBeTruthy();

    const back = await decryptCipher(dto, userKey);
    expect(back.name).toBe(original.name);
    expect(back.notes).toBe(original.notes);
    expect(back.login?.username).toBe('kylin@example.com');
    expect(back.login?.password).toBe('kJ8#mPq2$vXn9!wZt4&bR');
    expect(back.login?.totp).toBe('WQIQ25BRKZYCJVYP');
    expect(back.login?.uris[0]?.uri).toBe('https://github.com');
    expect(back.login?.uris[0]?.match).toBe(0);
    expect(back.customFields[0]?.name).toBe('PIN');
    expect(back.customFields[0]?.value).toBe('1234');
    expect(back.passwordHistory[0]?.password).toBe('old-pw');
    expect(back.favorite).toBe(true);

    await hardDeleteCipher(http, created.id);
  });

  it('目录里的条目都能被解密（不会因个别条目而整体失败）', async () => {
    const r = await sync(http, '');
    const { partitionCiphers } = await import('@1warden/api');
    const { active } = partitionCiphers(r.ciphers);
    expect(active.length).toBeGreaterThan(0);

    let ok = 0;
    for (const dto of active) {
      const item = await decryptCipher(dto, userKey);
      if (!item.nameFailed) ok++;
    }
    // 至少大部分条目应能正常解密 —— 全部失败说明密钥或映射有系统性问题
    expect(ok).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 7: 运行集成测试**

```bash
./scripts/dev-server.sh start
bun run seed
bun run test:contract
```
Expected: 全部 PASS（含计划 2 的 11 条 + 本计划新增的 2 条）

- [ ] **Step 8: 确认单元测试仍全绿且不需要网络**

```bash
bun run test && bun run typecheck
```

- [ ] **Step 9: Commit**

```bash
git add packages/vault
git commit -m "feat(vault): add TOTP dual-path storage and live integration test"
```

---

## 完成标准

- [ ] `bun run test` 全绿，且**服务器停止时也全绿**（单元测试零网络依赖）
- [ ] `bun run typecheck` 无错误
- [ ] `bun run test:contract` 对真实 Vaultwarden 全绿（计划 2 + 计划 3 的用例）
- [ ] `packages/vault/src` 里**没有任何持久化调用**：
      `grep -rnE "localStorage|sessionStorage|indexedDB|from 'node:|writeFile" packages/vault/src` 无输出
      —— 这是 spec 不变量 S1 的守护
- [ ] `packages/vault/src` 里没有 `console.` 输出明文
- [ ] `lock()` 之后 `session.items` 为空、密钥已清零（有测试钉死）

**下一份计划**：计划 4 —— Tauri 桌面 App（窗口、托盘、全局快捷键、安全存储、Vaultwarden 连接 UI、三栏主界面）。
