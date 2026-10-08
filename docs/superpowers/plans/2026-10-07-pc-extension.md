# PC UI Extension Implementation Plan

> **For agentic workers:** Use executing-plans for coordinated implementation; parallel workers own disjoint files. User explicitly requested implementation and parallel analysis/review.

**Goal:** Run the existing PC interface directly in Chrome and Firefox extensions and remove the old extension UI.

**Architecture:** Shared App/screens consume ApplicationClient. One local application service protects domain metadata and projects safe display data; the extension transports explicit operations to that service in its background. Browser-only actions are capabilities.

**Tech Stack:** TypeScript, React, Bun, Vite, Tauri, WebExtensions.

**Spec:** `docs/superpowers/specs/2026-10-07-pc-extension-design.md`

## Global Constraints

- Reuse PC layouts; do not preserve a second extension UI.
- Never send keys or full vault plaintext to UI; read single-item editable fields only after explicit edit.
- Retain browser autofill, capture, Passkey, account/session continuity.
- Test real Chrome and Firefox in isolated profiles; never use personal browser data.

## Review Focus

- Background wake or lock while a read/write is in flight: stale snapshots must not restore secrets.
- Editing a record with an item key, Passkey, attachment and history: preserve all server metadata.
- Content script invokes an otherwise valid UI RPC: deny before reading any secret.
- Popup closes after copy or save: cleanup and mutations must continue in background.
- Narrow view navigates into details/report/import/settings: return and navigation remain reachable.

## Tasks

- [x] Application contract/service/client: implement `src/application/types.ts`, safe projections and explicit mutations with tests using fake-server/domain fixtures; run red then green before integration.
- [x] PC screens: consume ApplicationClient, retain layouts, async detail/search/report/import, capability actions; fix narrow navigation and errors; switch both entries to App and remove Popup/ItemDetail.
- [x] Browser runtime: typed RPC, trusted sender validation, serialization/persistence/notifications, client adapter and browser actions; tests for denial, metadata, snapshot races and lock.
- [x] Chrome/Firefox: common build plus browser manifests, real clipboard lifecycle, new isolated-browser smoke coverage; repair obsolete documentation.
- [x] Verify `bun run check`, desktop frontend/mobile/Chrome/Firefox builds, existing extension E2E plus shared UI interaction tests and screenshots at desktop and popup widths.
- [x] Independent review of full diff against spec, fix significant findings, rerun affected tests and final acceptance audit.

## Review and acceptance evidence

- Removed both standalone extension screen files and the fake browser preview; extension and native entries now render `src/App.tsx`. The browser stylesheet imports PC CSS directly.
- Real Edge + local Vaultwarden E2E covers capture/save, fill, explicit edit and safe detail, create/favorite/trash, folder create/rename/delete, Passkey cryptographic assertions, and actual 30-second clipboard clearing. Test-created records/folders are removed.
- Local Edge 154.0.4258.62: 32 real-browser checks including encrypted attachment download with byte comparison, popup-close clipboard expiry and preservation of a later copy. Report: `/tmp/onewarden-local-browser-smoke/edge-report.json`.
- Local Zen 1.22.3b: 26 real-browser checks. Report: `/tmp/onewarden-local-browser-smoke/zen-report.json`. Privileged-page BiDi interactions use DOM events because native inputs/screenshots are unsupported by this engine interface.
- Additional official Chrome 155 / Firefox 157 runs passed core UI/runtime checks; Firefox also passed both real clipboard lifecycle cases. These were earlier builds; exact hashes are retained in their reports rather than presented as final-build evidence.
- Desktop PC preview reviewed at 1280×800 (`/tmp/onewarden-pc-wide.png`); shared PC narrow layout passed 9 actual Edge interaction checks at 440×600, including settings/editor/detail.
- Independent review found and drove fixes for queued lock, real API 2FA recognition/resume, and late authentication responses. Further checks cover encrypted-write and native-sync races at lock boundaries before final acceptance.
- The previous extension E2E had an always-true offscreen-log assertion. It now checks the actual system clipboard; this caught the Chromium offscreen focus restriction and verified the DOM clipboard fix with the popup closed.

### Validation limits

Mobile frontend builds successfully; no new mobile device/simulator run is claimed. Firefox/Zen attachment saving opens a native file picker; completed file bytes were checked on Edge/Chrome. All browser automation uses temporary profiles, not personal browser data. No release/signing, remote push or commit is part of this working-tree implementation.

### Final acceptance — completed

- `bun run check`: 919 tests / 71 files passed, including typecheck. Log `/tmp/onewarden-final-check.log`.
- `bun run e2e:extension`: 52 checks passed on Edge against local Vaultwarden. Log `/tmp/onewarden-final-e2e.log`.
- Desktop frontend, mobile frontend, Chrome+Firefox, and both shared preview builds passed. Existing Vite deprecation/chunk-size notices remain non-failing.
- Final frozen Edge build: 28 checks passed, including real attachment bytes; Zen: 26 checks passed. Zero uncaught UI errors. Reports `/tmp/onewarden-final-browser-smoke/{edge,zen}-report.json` hash all 14 runtime files, including the shared domain chunk.
- All 21 non-manifest Chrome/Firefox build files are byte-identical.
- Final independent review found no remaining blocking issue in the changed application, bridge and lifecycle scope. Regression coverage includes 2FA retry/re-unlock, stale authentication, queued lock, storage write/clear ordering, lock during encryption/import, and old sync after a new unlock.
- `git diff --check` passed. Changes remain uncommitted in the current working tree.

### Follow-up: collapsed native Zen toolbar popup

- The interaction smoke above opens the extension in a tab with a fixed viewport. It did not validate native toolbar sizing. The old actual Zen popup measured 0×0 in both connect and synthetic unlocked states; preserved measurements: `/tmp/onewarden-toolbar-before-report/red-observation.json`.
- Fixed `extension/styles.css` to size `body` explicitly at 440×600 without viewport-relative caps. The existing CSS guard failed before the fix and passed after it. Chrome and Firefox artifacts were rebuilt.
- Reloaded the existing extension in the user's original Zen window and clicked its toolbar icon. The complete connect form visibly rendered. Screenshot: `/var/folders/3_/03n880191ld4n90h_6xtyk880000gn/T/orca-computer-use/d313eee6-31c4-4847-98a1-cd0d03a01ff9-screenshot.png`. No credentials or personal vault data were accessed.
- Added `scripts/toolbar-popup-smoke.ts`, which opens a native action popup and measures its actual window/body/root without a viewport override. Its last Zen window-ID fallback change was compiled but not rerun headed after the user questioned the additional test window. Native automated green is not claimed; all temporary browser windows were closed.
- Updated the separate tab interaction smoke to use 440×600. The earlier full-suite and interaction reports predate this CSS follow-up.

### October 8 follow-up acceptance

- Source remains uncommitted. No personal vault records were merged or deleted. User explicitly requests investigation before deciding on account grouping.
- `bun run check`: 954 tests across 73 files and TypeScript passed (`/tmp/onewarden-followup-check.log`). Desktop, mobile, both extensions and both previews rebuilt; logs `/tmp/onewarden-final-{extension,platform}-build.log`.
- Edge + local Vaultwarden E2E: 52 checks passed (`/tmp/onewarden-final-e2e.log`). Headless Edge/Zen shared-UI smoke: 26 checks each. Those runs include all functional changes; the last CSS-only follow-up adds native/mobile safe-area spacing to narrow panels.
- Failed-form reopen smoke: 10 checks each on Edge and Zen, including edits not submitted, retained errors, cleared master password, no automatic login, and no silent selection of the first remembered account. The picker regression was reproduced before its form/quick-only persistence fix.
- Inline account picker: 16 actual-extension checks each on Edge/Zen, including the response from the original trusted unlock click and a rendered password field in the real popup. Reports: `onewarden-inline-artifacts-Ic8gLj` (Edge) and `onewarden-inline-artifacts-npBQ7l` (Zen), under the OS temporary directory. No substitute second unlock request is used.
- Native toolbar geometry passed in both connect and unlocked states on Edge/Zen without popup viewport overrides. Reports `/tmp/onewarden-toolbar-final-screen/{edge,zen}-toolbar-report.json`. Edge headless needed its virtual screen set to 1600×1200: its default 800×600 screen clipped the popup to 502px even with a 1200×900 window; this was a harness constraint, not a popup resize fix.
- Shared panel motion: 58 headless Edge checks against the final shared preview build, including 440×600 full-window cards, 1280×800 dialogs, retained detail/delete exits, topmost Escape, focus restoration, interrupted closing, reduced motion, and native/mobile safe-area spacing. Log `/tmp/onewarden-final-panel-motion.log`; screenshots `/tmp/onewarden-panel-motion`.
- Startup snapshot fast path, coalesced restoration, authentication protection, and expiry cancellation passed focused lifecycle review. Final headless Zen PBKDF2/Argon2, pending-login reopen and idle restoration: `/tmp/onewarden-zen-auth-final-report/report.json`. A server with idle timeout disabled observed the actual client abort at 30,001ms; after 35s with extension views closed, snapshot and explicit fresh connect still worked (`/tmp/onewarden-zen-auth-timeout-report/report.json`).
- Original missing-receiver error remains unreproduced; its cause is not established. Chinese retry errors and a five-second snapshot timeout avoid an indefinite empty spinner without automatically retrying a mutation.
- Latest account-dimension investigation: one VaultItem produces one summary/row; each login can contain multiple URIs and details already display them all. After the user unlocked locally, a scoped read-only audit of the three Bilibili entries confirmed three distinct IDs, one URI each, identical usernames/passwords, no TOTP/notes/custom fields/attachments/password history, and equal folder/favorite/reprompt settings. Comparisons ran inside the extension context through search/getDraft/getItem; only equality flags and non-sensitive metadata were logged, never password values. This group is a candidate for one multi-URI login record, but no personal record was merged/deleted/changed and no automatic grouping behavior was implemented. The latest build has not been reloaded into that personal browser.
