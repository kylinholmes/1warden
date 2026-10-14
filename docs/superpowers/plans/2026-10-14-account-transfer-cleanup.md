# Account transfer and vault cleanup implementation plan

> **For agentic workers:** Use test-driven-development and verification-before-completion. Independent domains are delegated using dispatching-parallel-agents; shared application integration remains with the coordinator.

**Goal:** Copy another unlocked account into the current account, resume interrupted imports by skipping existing content, move all personal records to trash, and empty personal trash.

**Architecture:** All secret reads, content comparison, and writes remain in the vault/application owner. Presentation receives counts and explicit results. Native and extension account owners resolve source sessions without switching the selected account.

**Tech Stack:** TypeScript, React, Vitest, Bun, existing Vaultwarden API.

**Spec:** User request in this conversation; all personal records including archives move to trash, confirmed by user. Migration copies and retains the source. File and account imports offer skip-existing, enabled by default.

## Global constraints

- Do not mutate actual user records during verification; use synthetic local Vaultwarden accounts.
- Exclude internal profile and organization records from personal bulk operations and migration.
- Lock, logout, account switch, and expiry cancel pending work at every asynchronous boundary.
- Compare supported full record content, never names alone. Refresh target records before deduplication, including archives but excluding trash.
- Confirmation displays account, count, and reversible/permanent consequence. Commit acts only on previewed records still eligible.
- Push after checks; only successful main CI publishes an automatically incremented patch release.

## Review focus

- A server accepts a record but its response is lost: refreshed retry skips that record.
- Equal names with different passwords, custom fields, URIs, or folders remain distinct.
- A source/target session locks while a migration is pending: no subsequent writes or stale UI result.
- New/restored/organization/profile records appear between deletion preview and commit: never enlarge or change the confirmed scope.
- Partial failures retain useful results and a retry path; no silent success or invisible failures.

### Task 1: Import deduplication

Files: `packages/vault/src/client.ts` (import section only), new import dedupe module/tests.
Interface: `importItems(items, onProgress?, folderNames?, options?: {skipExisting?: boolean; assertCurrent?: () => void | Promise<void>})` returns `{created, skippedExisting, failed}`.
- [x] Add failing regression tests for partial write/retry, changed content, folders, archives and cancellation.
- [x] Implement fresh authoritative target read and canonical content comparison; preserve deliberate duplicates when disabled.
- [x] Run focused domain tests.

### Task 2: Bulk deletion

Files: new vault bulk-delete module/tests, client deletion section; `screens/BulkDelete.tsx`, `TrashView.tsx` and UI tests.
Interfaces: `previewBulkDelete(scope: 'vault'|'trash')` returns `{token,scope,count,account:{serverUrl,email}}`; `commitBulkDelete(token)` returns `{completed, skipped, failed: {name,reason}[]}`. Shared types exported by vault package.
- [x] Test stale previews, account boundaries, profile/organization exclusion, archives, partial failures and single-use confirmation.
- [x] Implement short-lived preview bound to session and scoped commit with fresh membership verification.
- [x] Build confirmation UI and empty-trash action; expose reusable vault-delete panel for transfer page.
- [x] Run focused tests.

### Task 3: Account migration ownership

Files: `application/account-sessions.ts`, new account migration helper, extension session store/background, focused tests.
Interfaces: `previewAccountImport(source: AccountTarget): Promise<ImportPreview>`; `importAccount(source: AccountTarget, options: {skipExisting:boolean}): Promise<ImportOutcome>`. Preview may include `warnings?: string[]`.
- [x] Test source selection without active-account switch, own-account rejection, both session boundaries, fresh source reads and safe secret ownership.
- [x] Implement personal export-to-import conversion within the application owner and bind source/target through writes.
- [x] Implement extension source access with expiry checks and cleanup without changing active selection.
- [x] Run focused tests.

### Task 4: Integration and delivery

Files: application types/service/client, extension RPC/client, import page and shared ImportView, integration tests, local server smoke.
- [x] Add methods to explicit native/RPC contracts and validate input options; add boundary regression tests.
- [x] Add source selector, default skip-existing option, partial-result retry, visible skipped counts, and vault cleanup entry.
- [x] Test two synthetic accounts on existing local Vaultwarden, including retry and cleanup.
- [x] Review all changes; run typecheck/unit tests, builds and relevant UI smoke.
- [x] Commit/push, monitor main CI and automatic release; record verification evidence.

## Verification evidence

- `bun run check:ci`: workflow policy passed.
- `bun run check`: 166 files, 1,961 tests passed, 2 existing skips; typecheck passed.
- `bun scripts/ci-smoke.ts ui`: all 10 stages passed; evidence `/var/folders/3_/03n880191ld4n90h_6xtyk880000gn/T/1warden-ci-ui-LVOGOL/summary.json`.
- `bun run build:extension` and `bun run build:mobile`: passed.
- Local Vaultwarden loopback server: 32 checks passed with two disposable synthetic accounts, including partial upload with accepted response lost, retry without duplicates, source retention, archived records, profile exclusion, late additions, and restored-item protection.
- Independent review: no unresolved actionable findings; passkey empty metadata normalization and malformed deletion-state scope regressions fixed. 200 focused reviewer tests passed.
- Browser visual check: file drop preview, export tab, narrow layout, unsupported-file errors, no runtime errors.

Limitations: migration copies supported record fields and folders; attachments require separate migration and previews explain exclusions. Server APIs do not support conditional deletion, so another client can still alter a record between the final read and deletion. Concurrent independent imports lack server-side atomic idempotency; this feature protects sequential retries.

## Delivery

- Feature commit: `e3458b681ca89b31865a80cd0d78acbb66c5a3dc` on main.
- [Main CI run 38596291627](https://github.com/kylinholmes/1warden/actions/runs/38596291627): all eight jobs succeeded, including Windows native WebView2, both browser smoke suites, real Vaultwarden, platform packages, and gated release publication.
- Automatically published [v0.2.4](https://github.com/kylinholmes/1warden/releases/tag/v0.2.4) only after the seven required checks passed; release is public and final, with ten assets including signed macOS updater, Windows installers, Chromium/Firefox archives, updater manifest and checksums.
- Automatic version commit `c37aa54` fast-forwarded into the local workspace. No actual user vault records were modified during verification.
