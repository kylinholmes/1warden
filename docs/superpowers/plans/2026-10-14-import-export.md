# Import and Export Implementation Plan

> **For agentic workers:** Use executing-plans for inline integration and independent workers for the isolated domain codec and native file-drop adapter. Steps use checkbox syntax for tracking.

**Goal:** Support dropping import files into the main window and a unified import/export page with encrypted JSON, JSON and CSV exports.

**Architecture:** Extend the existing import service and native file-save boundary. Keep decrypted records and export passwords in memory, build compatible files in the vault domain, and keep host-specific file access outside that domain. One sidebar entry opens two tabs; dropping a file opens import preview, never writes records without confirmation.

**Tech Stack:** TypeScript/React/Zustand, existing @1warden/crypto primitives, Tauri/Rust, Vitest, native tests and browser smoke.

**Spec:** User instructions in this conversation: window-wide file drop imports by default, unsupported formats show an error, export support, merged sidebar/page; confirmed encrypted JSON + JSON + CSV.

## Global Constraints

- Default to password-protected Bitwarden-compatible encrypted JSON; support decrypting it on import.
- Ordinary JSON/CSV export requires a visible plaintext notice and explicit export action; never save automatically.
- Scope exports to the current unlocked individual vault. Exclude trash and internal profile records; surface format omissions and unreadable records.
- Preserve supported fields in JSON, including custom fields, passkeys and password history; do not export internal encryption keys, tokens or preservation envelopes.
- CSV supports the documented compatible subset and reports excluded types/fields. Attachments are not bundled by these formats.
- Native file reads originate only from an actual main-window drop, with one regular file and a 50 MiB limit; no arbitrary-path filesystem command.
- Browser and native drops share the import path, preserve unsaved item edits, and reject concurrent replacement while import/export is running.
- Account changes, lock and unmount invalidate pending file/crypto results. Never persist imported bytes, plaintext exports or passwords in presentation storage.
- Existing main CI release automation remains unchanged; synthetic fixtures only, no personal vault data.

## Review Focus

- Real Finder/Explorer drops differ from DOM events: test native delivery, duplicate prevention and quick-window isolation.
- Late file reads/crypto after account switch must not appear or save in the new account.
- Wrong-password and malformed/expensive encrypted files must fail explicitly and remain retryable.
- Export/import round trips must preserve fields beyond the basic login, and corrupt records must not yield a silently incomplete backup.
- Cancelled save dialogs, unsupported formats, multiple files and folders must have correct visible outcomes.

### Task 1: Vault export and encrypted import codecs

**Files:** New vault export/encrypted-import modules and tests; extend import-dispatch/import-json/import models as needed, and the importItems field mapping only.

**Interfaces:** Export a typed `ExportFormat` and `createVaultExport` accepting decrypted `VaultItem[]`, `VaultFolder[]`, format and optional independent password; return bytes, filename and counts/warnings. Expose encrypted-import detection and extend parseImport with optional password. Coordinate final signatures with the integrator before adoption.

- [x] Research official Bitwarden format and password-encryption derivation; use existing crypto primitives.
- [x] Write failing tests for field preservation, CSV omission reporting, password round trip, wrong password, malformed/KDF limits and absence of internal keys.
- [x] Implement codecs and any import preservation needed for a faithful round trip.
- [x] Run targeted codec/import tests; report interoperability evidence.

### Task 2: Native/browser file-drop adapter

**Files:** New `apps/desktop/src/file-drop.ts` and tests, native dropped-file module/tests and registration in `src-tauri/src/lib.rs`.

**Interfaces:** `subscribeFileDrops({ onDragging(boolean), onDrop({name,dataBase64}), onError(string) }): () => void`; callbacks scoped to the main window. Native reads accept only OS-dropped paths, emit only to main, and enforce the shared 50 MiB limit.

- [x] Test regular file/empty/multiple/directory/oversized handling and cleanup.
- [x] Implement native adapter plus browser DOM file drop without exposing arbitrary file reads.
- [x] Verify native compilation/tests and DOM adapter tests; give integrator a real-window test route.

### Task 3: Application boundary and unified page

**Files:** Application types/service/client/extension RPC allowlist; unified Import screen, Export view, VaultView and sidebar; relevant UI tests.

- [x] Add service export and password-aware import operations with unlock, sync completeness and account-generation guards.
- [x] Build one sidebar entry and two accessible page tabs, default encrypted export, independent password/confirmation and filename/save result handling.
- [x] Wire window-wide drops into import preview with drag overlay; preserve unsaved editors and reject unsupported files explicitly.
- [x] Cover export cancellation, lock/account races, decrypt retry, merged navigation and dropped-file preview in tests.

### Task 4: Verification and delivery

- [x] Run typecheck, complete unit tests, native tests and platform builds.
- [x] Exercise synthetic export/import round trips and browser drop interactions.
- [ ] Manually verify a real Finder drop: native build, ticket rejection and event/adapter tests pass, but this environment did not deliver an OS drop from synthetic pointer input. See ignored `.dev/drop-native-smoke/report.json` for the isolated test route.
- [x] Request independent review and fix findings.
- [ ] Commit/push and observe main CI and automatic release.

## Verification evidence

- `bun run check`: 162 test files, 1847 passed, 2 existing skipped; typecheck passed.
- `cargo test --lib`: 54 passed, 4 existing ignored.
- Extension, mobile, preview and isolated macOS app builds passed.
- Complete browser UI smoke passed; explicit drop/preview/export/narrow/unsupported-file browser exercise passed.
- Local Vaultwarden at `https://localhost:8443`: 22 synthetic registration/write/export/import/fresh-sync/cleanup checks passed, including archive state, passkeys and password history.
- Official pinned Bitwarden CLI accepts our encrypted JSON and CSV; its PBKDF2 and Argon2id encrypted exports import successfully.
- Independent review found no remaining P1/P2 findings. Archive completeness, empty folders, native passkey metadata and completed/cancelled browser downloads were corrected during review.
