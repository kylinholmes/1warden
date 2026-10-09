# Bitwarden / Vaultwarden API 备忘

> 来源：对 `dani-garcia/vaultwarden` 1.37.3、`bitwarden/server`、`bitwarden/clients` 源码的直接阅读（2026-10-04）。
> **本文档纠正了设计文档初稿中的若干错误假设**，实现时以本文档为准。
> 未经运行中的服务器验证 —— 全部读自源码。
>
> 2026-10-09 补核：原生类型 6–8 按 [Vaultwarden 1.37.4](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/src/api/core/ciphers.rs)
> 和 Bitwarden 官方 [银行账户](https://github.com/bitwarden/clients/blob/main/libs/common/src/vault/models/domain/bank-account.ts)、
> [驾照](https://github.com/bitwarden/clients/blob/main/libs/common/src/vault/models/domain/drivers-license.ts)、
> [护照](https://github.com/bitwarden/clients/blob/main/libs/common/src/vault/models/domain/passport.ts) 模型接入。
> 这些类型的全部字段（包括日期）均为 EncString；不是新增自定义字段类型，后者仍仅 0–3。

---

## 0. 通用约定

- **JSON 线上格式绝大多数是 lowerCamelCase**（`folderId`、`revisionDate`、`viewPassword`）。
- **例外用 PascalCase**：`/identity/connect/token` 的响应、SignalR 通知载荷。
- **日期格式统一**：UTC + 恰好 6 位小数 + `Z`，如 `"2026-10-04T12:34:56.789012Z"`。服务端解析用严格 RFC3339（`%+`）。
- **挂载点**：`/`（web，含附件下载）、`/api`、`/admin`、`/identity`、`/icons`、`/notifications`。`/events` 是**客户端遥测上报**，不是 SSE。
- `GET /api/config` 的 `version` 是 **Vaultwarden 模拟的 Bitwarden 服务端版本**（如 `"2026.6.0"`），不是 Vaultwarden 自身版本。
- **请求头**：`Bitwarden-Client-Version` 缺失或 `< 2024.12.0` 时，sync 会过滤掉 SSH key 类条目。我们要发一个较新的版本号。

---

## 1. 同步

### `GET /api/sync[?excludeDomains=true]`

```jsonc
{
  "profile": { … },        // 与 /api/accounts/profile 返回的对象逐字节相同
  "folders": [ { "id","revisionDate","name"(EncString),"object":"folder" } ],
  "collections": [ … ],    // object: "collectionDetails"
  "policies": [ … ],
  "policiesNew": [ … ],    // policies 的超集（含 Accepted 成员）；新客户端优先用这个
  "ciphers": [ … ],        // 见 §2
  "domains": { … } | null, // excludeDomains=true 时为 null
  "sends": [ … ],
  "userDecryption": { "masterPasswordUnlock": null | { kdf:{kdfType,iterations,memory,parallelism}, masterKeyEncryptedUserKey, masterKeyWrappedUserKey, salt }, "userKeyId": null },
  "object": "sync"
}
```

**要点**：
- **无分页**。无 `continuationToken`。一次性全量返回。
- **Vaultwarden 不在顶层返回 `Organizations`/`Providers`** —— 它们在 `Profile.organizations` / `Profile.providers` 里。
- `Profile` 中 Vaultwarden 恒定：`premium: true`、`culture: "en-US"`、`organizations` 结构见源码。
- **`/api/sync` 会返回已软删除的条目**（`deletedDate != null`）。客户端自己按 `deletedDate` 分区到「回收站」。服务端**没有** `deleted_at` 过滤。
- 除非运营方设了 `TRASH_AUTO_DELETE_DAYS`，**回收站永不自动清空**（默认未设置）。不要假设 30 天。

### 同步节流（重要性能点）

`GET /api/accounts/revision-date` → **裸 JSON 整数**，epoch **毫秒**（如 `1759500000000`）。
若该值 ≤ 上次同步时间，**完全跳过 sync**。官方客户端就是这么做的，是最大的性能杠杆。

### 其他读取

| 端点 | 说明 |
|---|---|
| `GET /api/accounts/profile` | 与 `Sync.Profile` 逐字节相同，不含保险库数据 |
| `GET /api/ciphers` | `{data:[…],object:"list",continuationToken:null}`，**不分页**，无客户端在用 |
| `GET /api/ciphers/{id}` | 单个条目，`cipherDetails` |
| `GET /api/ciphers/{id}/details` | **与上一条完全等价**（就是同一个 handler） |
| `GET /api/folders` | `{data:[…],object:"list",continuationToken:null}` |

---

## 2. Cipher 数据模型

### 2.1 序列化形态

Vaultwarden **只实现最详细的那一种**，永远返回 `object: "cipherDetails"`。

```jsonc
{
  "object": "cipherDetails",
  "id": "<uuid>",
  "type": 1,                       // CipherType，明文
  "creationDate": "…", "revisionDate": "…", "deletedDate": null, "archivedDate": null,
  "reprompt": 0,                   // 0=None, 1=PasswordOnView
  "organizationId": null, "folderId": null,
  "key": null,                     // 每条目独立密钥（EncString）或 null
  "attachments": null,             // 无附件时为 null，不是 []
  "organizationUseTotp": true,     // Vaultwarden 恒为 true
  "collectionIds": [],             // 个人条目为 []
  "name": "2.…",                   // EncString
  "notes": "2.…" | null,
  "fields": [], "passwordHistory": [],
  "login": null, "secureNote": null, "card": null, "identity": null,
  "sshKey": null, "bankAccount": null, "driversLicense": null, "passport": null,
  // 以下仅在 sync_type == User 时出现：folderId, favorite, archivedDate, edit, viewPassword, permissions
  "favorite": false,
  "edit": true, "viewPassword": true,
  "permissions": { "delete": true, "restore": true }
}
```

> `edit`/`viewPassword` 是旧字段，`permissions` 是 2025.6+ 的替代。**优先读 `permissions`，回退到 `edit`/`viewPassword`。**

### 2.2 加密 vs 明文

| 明文 | EncString |
|---|---|
| `id`, `type`, `creationDate`, `revisionDate`, `deletedDate`, `archivedDate` | `name` |
| `organizationId`, `folderId`, `collectionIds[]` | `notes` |
| `favorite`, `reprompt`, `edit`, `viewPassword`, `permissions.*` | `key`（存在时） |
| `organizationUseTotp` | `fields[].name`, `fields[].value` |
| `attachments[].id/url/size/sizeName` | `attachments[].fileName`, `attachments[].key` |
| `fields[].type`, `fields[].linkedId` | `passwordHistory[].password` |
| `login.uris[].match`, `login.passwordRevisionDate`, `secureNote.type` | Login/Card/Identity 里其余全部字段 |

### 2.3 CipherType

```csharp
Login = 1, SecureNote = 2, Card = 3, Identity = 4,
SSHKey = 5, BankAccount = 6, DriversLicense = 7, Passport = 8
```
`0` = Folder 已废弃。**超出 1–8 会让 Vaultwarden 的 `to_json` 直接报错**（整个 sync 响应 500）。

### 2.4 ⚠️ Card：品牌是字符串，不是数字枚举

**不存在** `Visa=0, Mastercard=1` 这样的数值枚举。`brand` 是自由字符串：

| 显示 | 存储值 |
|---|---|
| Visa | `"Visa"` |
| Mastercard | `"Mastercard"` |
| American Express | **`"Amex"`** |
| Discover | `"Discover"` |
| Diners Club | `"Diners Club"` |
| JCB / Maestro / UnionPay / RuPay / Other | 同名 |

`expMonth` / `expYear` 也是**字符串**且**加密**。

### 2.5 ⚠️ Linked field 是数字 ID，不是 `"login.username"` 字符串

```ts
LoginLinkedId    = { Username: 100, Password: 101 }
CardLinkedId     = { CardholderName: 300, ExpMonth: 301, ExpYear: 302, Code: 303, Brand: 304, Number: 305 }
IdentityLinkedId = { Title: 400, MiddleName: 401, Address1: 402, Address2: 403, Address3: 404,
                     City: 405, State: 406, PostalCode: 407, Country: 408, Company: 409,
                     Email: 410, Phone: 411, Ssn: 412, Username: 413, PassportNumber: 414,
                     LicenseNumber: 415, FirstName: 416, LastName: 417, FullName: 418 }
```
JSON 键名是 **`linkedId`**（小写 l）。**没有 200 段。** 超出 100–418 会破坏真实客户端。

`"login.username"` 那类字符串只出现在 CSV 导入导出的列名里，**不是线上格式**。

### 2.6 FieldType

`0 = Text`, `1 = Hidden`, `2 = Boolean`, `3 = Linked`。
Vaultwarden 在 `type` 缺失或无法解析时回退到 **`1`（Hidden）**，不是 0 —— 为了防止意外泄露。

### 2.7 Login

```jsonc
"login": {
  "username": "2.…"|null, "password": "2.…"|null,
  "passwordRevisionDate": "…"|null,          // 明文
  "totp": "2.…"|null,                        // EncString，内容是 otpauth:// URI 或裸 base32
  "uris": [ { "uri": "2.…", "uriChecksum": null, "match": null } ],
  "autofillOnPageLoad": null,                // 三态；null = 继承
  "fido2Credentials": [ … ],
  "uri": "2.…"|null                          // ⚠ 服务端为向后兼容自动补的，等于 uris[0].uri
}
```

**`Match`（UriMatchType）**：`null`=默认(Domain) · `0`=Domain · `1`=Host · `2`=StartsWith · `3`=Exact · `4`=RegularExpression · `5`=Never

### 2.8 Identity / SecureNote

- `identity` 全部字段为 EncString。**`ssn` 是全小写**（服务端有特殊的大小写归一化）。写解析器时精确匹配 `ssn`。
- `secureNote`：**只有** `{ "type": 0 }` 一个合法值。缺失或非数字会被强制修复为 `{"type":0}`。

### 2.9 PasswordHistory

```jsonc
{ "lastUsedDate": "…", "password": "2.…" }
```
`password` 非字符串的条目会被**整条丢弃**。`lastUsedDate` 解析失败会替换为 epoch `"1970-01-01T00:00:00.000000Z"`（不会省略、不会为 null）。

### 2.10 Attachments

```jsonc
{ "id","url","fileName"(EncString),"size":"12345"(⚠字符串),"sizeName":"12.06 KB","key"(EncString),"object":"attachment" }
```
- `url` 是**绝对 URL**，由请求的 `Host` 头推导，每次 sync 重新生成，**会过期**。
- 本地存储时形式为 `{host}/attachments/{cipherId}/{attachmentId}?token={jwt}` —— 在 **web 根路径，不在 `/api` 下**。
- 官方客户端策略：先调 `GET /api/ciphers/{id}/attachment/{aid}` 拿新 URL，404 时回退到存储的 url。

---

## 3. CRUD 端点

### 3.1 ⚠️ 软删除 vs 硬删除（动词是反直觉的）

```rust
POST   /api/ciphers/{id}/delete   → 硬删除（永久）
PUT    /api/ciphers/{id}/delete   → 软删除（进回收站）
DELETE /api/ciphers/{id}          → 硬删除（永久）
```

官方 TS 客户端命名可以印证：`putDeleteCipher()` = 进回收站；`deleteCipher()` = 永久删除。

批量同构：
- `DELETE /api/ciphers` （body 里带 `{ids:[]}`）→ **硬删除**
- `POST /api/ciphers/delete` → **硬删除**
- `PUT /api/ciphers/delete` → **软删除**
- `PUT /api/ciphers/restore` → 批量恢复
- 批量 body 统一为 `{ "ids": ["<uuid>", …] }`

### 3.2 Cipher 路由表（相对 `/api`）

| 方法 | 路径 | 语义 |
|---|---|---|
| `POST` | `/ciphers` | 创建个人条目，body = `CipherData` |
| `POST` | `/ciphers/create` | 创建组织条目 / **克隆任意条目**，body = `{cipher, collectionIds}` |
| `POST`,`PUT` | `/ciphers/{id}` | **全量更新** |
| `POST`,`PUT` | `/ciphers/{id}/partial` | **局部更新：仅 folderId + favorite** |
| `PUT` | `/ciphers/{id}/delete` | 软删除 |
| `POST`/`DELETE` | `/ciphers/{id}` | 硬删除 |
| `PUT` | `/ciphers/{id}/restore` | 从回收站恢复 |
| `POST`,`PUT` | `/ciphers/move` | 批量移动到文件夹 `{folderId, ids}` |
| `PUT` | `/ciphers/{id}/archive` / `/unarchive` | 归档 |

### 3.3 ⚠️ `CipherData` 请求体

```jsonc
{
  "encryptedFor": "<你的 user uuid>",   // ⚠ 必填，且必须等于自己，否则 422 "Invalid user cipher"
  "type": 1,
  "name": "2.…",                        // 必填
  "notes": null,
  "folderId": null,                     // ⚠ 必须显式发送（见下）
  "organizationId": null,
  "favorite": false, "reprompt": 0,
  "lastKnownRevisionDate": null,
  "archivedDate": null,
  "fields": null, "passwordHistory": null,
  "login": {…}, /* 或 secureNote/card/identity/sshKey/…，由 type 决定 */
  "encryptedByKeyId": null              // 仅 POST /ciphers 校验，不匹配 → 422 "Invalid key cipher"
}
```

**三个致命细节**：
1. **`encryptedFor` 必填**。缺失 = **反序列化失败**（不是校验错误）。2025.6 之前的客户端因此无法写当前 Vaultwarden。
2. **`folderId` 省略会移除该条目所属文件夹**。`folder_id` 是 `Option`，缺省得到 `None` → 删除 `folders_ciphers` 行。**全量更新时必须显式发送 `folderId`（无文件夹就发 `null`）。**
3. **`archivedDate` 语义是反的**：`Some(date)` → 归档；`None` → **取消归档**。全量 PUT 省略它 = 取消归档。

另外：`type` 对应的子对象为 `null` 时服务端报 `"Data missing"`。

### 3.4 乐观并发（RevisionDate）

客户端发送 `lastKnownRevisionDate` = 它认为的当前 `revisionDate`。
服务端：若该时间戳比服务端 `updated_at` **早超过 1 秒** → 拒绝（`"The client copy of this cipher is out of date. Resync…"`）。

**注意**：
- 解析失败只记 warning，**写入照常进行**（畸形日期会静默关掉保护）。
- **省略该字段 = 完全关闭检查**。
- `/partial` 和 `/move` **从不检查**。
- 比较的是**客户端回显的服务端时间戳**，不是客户端自己的时钟。

**做法**：每次全量 PUT 都带上 `lastKnownRevisionDate`；被拒绝时 `GET /api/ciphers/{id}/details` 后重新应用。

### 3.5 Folders

| 方法 | 路径 | Body |
|---|---|---|
| `GET` | `/api/folders` | → `{data:[…],object:"list",continuationToken:null}` |
| `GET` | `/api/folders/{id}` | 单个 |
| `POST` | `/api/folders` | `{ "name": "2.…" }` |
| `PUT` | `/api/folders/{id}` | `{ "name": "2.…" }` |
| `DELETE` | `/api/folders/{id}` | 200 空 body |

Folder JSON：`{id, revisionDate, name(EncString), object:"folder"}` —— **没有 `creationDate`**。

**Vaultwarden 缺失**（官方客户端有，我们会 404）：
- `DELETE /api/folders`（批量删除）
- `DELETE /api/folders/all`

删除文件夹会删除关联行，**条目本身存活**，变成无文件夹。

---

## 4. 账户

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/accounts/profile` | 同 `Sync.Profile` |
| `PUT`,`POST` | `/api/accounts/profile` | `{name}`，≤50 字符 |
| `GET` | `/api/accounts/revision-date` | **裸整数**，epoch 毫秒 |
| `POST` | `/api/accounts/prelogin` | **免认证**，限流。→ `{kdf,kdfIterations,kdfMemory,kdfParallelism,kdfSettings,salt}` |
| `POST` | `/api/accounts/verify-password` | `{masterPasswordHash}` |
| `POST` | `/api/accounts/password` | 改主密码（见下） |
| `POST` | `/api/accounts/kdf` | 改 KDF |
| `POST` | `/api/accounts/key-management/rotate-user-account-keys` | 密钥轮换 |
| `POST` | `/api/accounts/delete` / `DELETE /api/accounts` | **删除账户（不可逆）** |

- **`POST /api/accounts/key` 不存在** —— 已改名为 `…/key-management/rotate-user-account-keys`。
- **`POST /api/accounts/breach` 不存在。**
- 密钥轮换要求请求里包含**全部**现有 ciphers / folders / sends / 紧急联系人 —— 缺任何一项整个轮换中止。
- 通用再认证信封 `PasswordOrOtpData`：`{masterPasswordHash}` 或 `{otp}`，**两者只能给一个**（都给会报 `"No validation provided"`）。

---

## 5. TOTP —— 纯客户端

**服务端没有任何 TOTP 生成端点。** 三处独立验证（Vaultwarden / bitwarden-server / bitwarden-clients）均为零命中。

- `organizationUseTotp`（Vaultwarden 恒 `true`）只用于 UI 决定是否显示验证码行。
- 密钥存在 `login.totp`（EncString），内容是裸 base32 或 `otpauth://` URI（也可能是 `steam://`）。
- 客户端本地解密 + 本地生成。
- **密码生成器也没有服务端端点。**

---

## 6. 报表 / 加固检查 —— 必须本地计算

**`/api/reports/*` 在 Vaultwarden 中完全不存在**，组织级报表也没有。

| 报表 | 本地算法 |
|---|---|
| 弱密码 | 解密全部 `login.password`，本地评分 |
| 重复使用 | 按解密后的密码分组 |
| 不安全网站 | 过滤 `uris[].uri` 中 scheme 为 http 的 |
| 数据泄露 | 逐条 HIBP 查询，或走 §6.1 批量 |

### 6.1 HIBP

`GET /api/hibp/breach?username=<email>` —— 需认证。

- 配了 `HIBP_API_KEY`：服务端代理上游，返回上游 JSON 数组**原样**。上游 404 → 返回 404 空 body（= 无泄露）。
- **没配 key**：返回 **200** + 一个合成的单元素数组，其中 `pwnCount: 0` 且 `dataClasses[0] === "Error - No API key set!"`。**这是一个 200，不是错误** —— 必须显式检测这个特征串。

---

## 7. 通知 —— SignalR + MessagePack

- 端点：`GET /notifications/hub`（`wss://`）。另有免认证的 `/notifications/anonymous-hub`。
- **不是 JSON 协议**。客户端发文本 `{"protocol":"messagepack","version":1}`，服务端回二进制 `{}` + `0x1E`（字节 `7b 7d 1e`）。
  发 `{"protocol":"json",…}` 会**完全没有响应**。
- **无 negotiate 步骤** —— 官方客户端的 `skipNegotiation: true` 在 Vaultwarden 这里是**必需的**，不是优化。
- **无 SSE**。`/events` 是客户端遥测上报，不是事件流。
- 认证：`?access_token=<jwt>` 查询参数优先，回退到 `Authorization: Bearer`。用与 `/api` 相同的 access token。**JWT 过期后必须重连。**
- 帧格式：SignalR Invocation `[1, {}, nil, "ReceiveMessage", [ {ContextId, Type, Payload} ]]`。
- 每 **15 秒**一个 Ping（`[6]`）。
- `ContextId` 是触发变更的设备 uuid，可用来忽略自己造成的回声。
- **载荷里的时间戳是 MessagePack timestamp ext（`Ext(-1, …)`），不是字符串。**

### UpdateType 数值（Vaultwarden 实际会发的）

```
0  SyncCipherUpdate      1  SyncCipherCreate    2  SyncLoginDelete
3  SyncFolderDelete      4  SyncCiphers         5  SyncVault
6  SyncOrgKeys           7  SyncFolderCreate    8  SyncFolderUpdate
10 SyncSettings          11 LogOut              12 SyncSendCreate
13 SyncSendUpdate        14 SyncSendDelete      15 AuthRequest
16 AuthRequestResponse   100 None
```

**Vaultwarden 从不发 9，也从不发 17–22。**

### 客户端应有的反应

| 通知 | 动作 |
|---|---|
| `SyncCipherCreate` / `Update` | 先比 `revisionDate`：本地已是最新则**什么都不做、不发请求**；否则 `GET /api/ciphers/{id}/details` 后 upsert |
| `SyncCipherDelete` / `SyncLoginDelete` | 仅本地删除，**不发请求** |
| `SyncFolderCreate` / `Update` / `Delete` | 同上模式 |
| `SyncVault` / `SyncCiphers` / `SyncSettings` | **全量重新同步**（不走 revision-date 短路） |
| `SyncOrgKeys` | 全量同步 **+ 强制重连 WebSocket** |
| `LogOut` | 登出 |

---

## 8. 分页与性能

- **`/api/sync` 不分页**，无 `continuationToken`。
- **`/api/ciphers` 不分页**，`continuationToken` 恒为 `null`（纯装饰）。
- 唯一真实分页：`/api/organizations/{org}/events` 等事件日志，页大小 30。
- 服务端限制：JSON body **20 MB**；附件/Send **525 MB**。

### 官方客户端的四个策略（照抄即可）

1. **revision-date 短路** —— 最大的性能杠杆，优先实现。
2. **全量替换而非增量合并** —— 本地保险库是一个 `id → cipher` 的 map，**整体原子替换**，不做逐字段合并。服务端**不提供**增量同步原语。
3. **按通知单条刷新**，并用 `revisionDate` 比较挡住无变化的条目。
4. 非自动填充场景用 `excludeDomains=true`。

---

## 9. ⚠️ 对设计文档初稿的更正清单

| 初稿的假设 | 更正 |
|---|---|
| 卡品牌数值枚举 `Visa=0…` | **字符串** `"Visa"` / `"Amex"` 等，无枚举 |
| 关联字段 `"login.username"` | **数字 `linkedId` 100–418** |
| `PUT /ciphers/{id}/delete` = 硬删除 | **反了**：PUT 软删除，POST/DELETE 硬删除 |
| 有 `/api/reports/*` | **完全不存在**，本地算 |
| `POST /api/accounts/key` | 是 `…/key-management/rotate-user-account-keys` |
| `POST /api/accounts/breach` | 不存在，用 `GET /api/hibp/breach` |
| 通知是「简单 JSON 或 SignalR」 | **SignalR + MessagePack**，必须 messagepack 握手 |
| — | **`encryptedFor` 必填** |
| — | **`folderId` 省略会移出文件夹** |
| — | **`archivedDate: null` = 取消归档** |
| — | `ssn` 全小写 |
| — | `FieldType` 缺省回退到 **1 (Hidden)** |
| — | sync **会返回已删除条目**，客户端自己分区 |

---

## 9.5 接口稳定性分级（决定我们能依赖什么）

> **设计原则**：只依赖**长期不变**的接口，以支持尽可能大的服务端版本跨度。
> Bitwarden 协议有一条明确的"向后兼容线"：加密格式与密钥层级一旦定型就**永远不会改**
> （否则老客户端全部失效）。协议的核心部分因此非常稳定，风险集中在外围。

### 🟢 稳定层 —— 可以放心依赖

这些是协议的骨架，多年来没有破坏性变更。客户端的一切核心功能都建立在它们之上。

| 接口 / 格式 | 稳定理由 |
|---|---|
| EncString 格式与类型编号 | 定型即冻结，改了就解不开历史数据 |
| 密钥层级（KDF → 拉伸 → 用户密钥 → RSA） | 同上 |
| `POST /identity/connect/token`（password / refresh grant） | 认证协议核心 |
| `POST /identity/accounts/prelogin` | 同上 |
| `GET /api/sync` | 保险库读取的唯一入口，字段只增不减 |
| `/api/ciphers` 的 CRUD 与 `{id}/delete` 动词约定 | 核心写入路径 |
| `/api/folders` CRUD | 同上 |
| `/api/accounts/profile`、`/api/accounts/revision-date` | 账户基础读 |

### 🟡 需容错层 —— 可以依赖，但必须两种形态都吃

| 项 | 差异 | 做法 |
|---|---|---|
| prelogin 字段大小写 | Vaultwarden 用 camelCase，官方用 PascalCase | 两种都解析（已实现） |
| token 响应形态 | 老版扁平 `Key`/`PrivateKey`；新版额外有 `AccountKeys`/`UserDecryptionOptions` | 只读老字段，新字段有就用、没有就忽略 |
| `Key` 字段缺失 | 服务端为空时**整个字段不出现**，不是 `null` | 按 undefined 处理（已实现） |
| `archivedDate` | 较新字段 | **能力探测**：缺失时降级为"无归档功能"，不报错 |
| `policiesNew` vs `policies` | 新版优先 | 两者都读，优先 `policiesNew` |

### 🔴 不稳定层 —— **不要依赖**

| 项 | 为什么避开 |
|---|---|
| `/api/accounts/key-management/rotate-user-account-keys` | 新端点，Vaultwarden 未实现（会 404） |
| `/api/accounts/key-management/user-key-id` | 同上。新版官方 CLI 正是死在这里 |
| `Sends` 相关端点 | Vaultwarden 正在重构中（HEAD 提交就是 Send API cleanup） |
| `/api/reports/*` | Vaultwarden 完全不存在 → 报表一律客户端算 |
| 服务端 TOTP / 密码生成端点 | 不存在（三处独立验证） |
| `organizationUseTotp` | Vaultwarden 恒为 `true`，无信息量，不要据此做判断 |
| 类型 6/7/8（BankAccount / DriversLicense / Passport） | 已按 1.37.4 原生合同接入；旧服务端可能拒绝写入，此时保留错误，不降级或伪装为安全笔记。真正未知类型仍只读 |

### 具体做法

1. **新字段一律"有就用，没有就降级"**，绝不因为缺字段而崩溃
2. **绝不调用会 404 的端点** —— 需要某个能力时先探测
3. **写请求只发稳定字段**；`encryptedFor` 是例外（见下）
4. 启动时读 `/api/config` 的 `version`，仅用于**能力探测**，不用于拒绝服务
5. 读响应时**容错多余字段**（服务端加字段不应影响我们）

> **`encryptedFor` 的特殊说明**：它是当前 Vaultwarden **必填**的字段（缺失导致反序列化失败）。
> 老版本服务端不认识它，但会**忽略未知字段** —— 所以"总是发送"在两个方向上都是安全的。
> 这是一个罕见的、可以无条件发送的字段。

---

## 10. 未解疑点（留待实测）

1. Argon2id 的 `KdfMemory` 单位 —— 见计划 1 Task 4/10，用互操作测试定案。
2. Vaultwarden `main` 的 Sends 正在重构中（HEAD 提交是「Send API cleanup」）。**钉在 1.37.3**。
3. 上述一切均未在运行中的服务器上验证过 —— 全部读自源码。
