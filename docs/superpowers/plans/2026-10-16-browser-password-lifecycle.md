# Browser Password Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Implement approved browser capture/generation/recovery design plus the user's welcome/login server selector corrections.

**Architecture:** Browser content observes only the interacted form and sends short-lived captures to an account-bound background service. Existing trusted extension UI confirms writes; generated passwords are encrypted locally before filling. Shared entry UI starts bounded public latency probes on welcome and reuses their results in deduplicated server options.

**Tech Stack:** TypeScript, React, Zustand wrappers, WebExtension Promise APIs, existing vault/crypto/API packages, Vitest and existing Puppeteer smoke tools.

Spec: `docs/superpowers/specs/2026-10-16-browser-password-lifecycle-design.md`, approved by user on 2026-10-16. Additional approved UI scope: server before email; deduplicate saved/preset URLs; latency and status light per option; start probes on welcome. Work in current checkout on `feat/browser-password-lifecycle`; preserve unrelated logos. Baseline: 74 relevant tests passed.

## Task 1 — Shared server options and eager latency

Files: `packages/ui/src/ServerSelector.tsx`, `Select.tsx`, `ServerSpeed.tsx`; add `server-latency.ts`; entry forms and welcome screen; `apps/desktop/src/App.entry.test.tsx`, component tests.

- [x] Add failing behavior tests: normalized preset/saved URL appears once; server precedes email; mounting welcome starts each unique public server probe; all menu rows show measuring/result/failure text plus accessible light; reopening reuses results.
- [x] Run `bun run test apps/desktop/src/App.entry.test.tsx apps/desktop/src/components/ServerSpeed.test.tsx` and new tests, confirm failures are missing behavior.
- [x] Keep a shared module cache keyed by normalized public URL, with a five-minute TTL, at most three simultaneous public `probeServer(url, { mode: 'latency', fetchImpl: host().fetch, signal })` requests. Deduplicate inflight requests, notify subscribers, bound errors/timeouts through existing probe. Do not send account credentials. Welcome primes presets plus remembered server URLs; address editing remains debounced.

```ts
type LatencyState = { status: 'idle' | 'measuring' | 'error'; latencyMs?: never }
  | { status: 'ready'; latencyMs: number };
// Option presentation retains plain label for keyboard search and adds a suffix.
// Green <= 300 ms, amber <= 1000 ms, red > 1000 ms or failure; grey unknown.
// A slow red result still displays milliseconds, distinguishing it from failure.
```

- [x] Use preset labels for preset matches, one saved row per remaining URL; preserve URL path and custom edit selection. Move server selector before email on login/register forms using shared components.
- [x] Re-run related UI tests and inspect real dropdown/welcome rendering, then commit the scoped change after review.

## Task 2 — Field roles and capture decisions

Files: `packages/vault/src/form-fields.ts`, `credential-capture.ts`, their tests; exports if needed.

- [x] Add tests for tokenized autocomplete, one `new-password`, populated username, shown password metadata, OTP exclusion, duplicate same-user records and absent username. Retain existing correct matching tests.
- [x] Run `bun run test packages/vault/src/form-fields.test.ts packages/vault/src/credential-capture.test.ts` and observe expected failures.
- [x] Preserve the existing public classifier signature, add optional capture context where needed, and add a review decision for ambiguity. Caller groups fields before classification. Use explicit autocomplete roles first; recognize a single new password; prefer semantic usernames before positional fallback.

```ts
type CaptureIntent = 'login' | 'signup' | 'change';
type CaptureDecision = { kind: 'save' } | { kind: 'update'; itemId: string }
  | { kind: 'review'; itemIds: string[] }
  | { kind: 'none'; reason: 'noPassword' | 'placeholder' | 'noSite' | 'unchanged' };
// Username absent => review, never silently pick first empty username.
// Unique exact username => update when password differs.
// An identical matching username/password => unchanged, including duplicates.
```

- [x] Run domain tests green; review compatibility of callers, then commit.

## Task 3 — Document-scoped observer and submission lifecycle

Files: new `apps/desktop/extension/credential-observer.ts`, form DOM helpers; `content.ts`, `public/manifest.json`, build entry script; observer tests.

- [x] Test multi-form grouping, same-origin frame eligibility, new/confirm mismatch, immediate-navigation capture, username-first, synthetic submit without user interaction, stale document and empty-value handling.
- [x] Run new observer tests red.
- [x] Install isolated observer at document_start, assign random document/form IDs, read only interacted group on change/blur/submit intent. Send through runtime only; no page message bridge. Use trusted input to mark provenance/dirty; trusted Enter/click snapshots precede site clearing; actual submit confirms; formless semantic buttons count as intent. Background state receives document identity from browser sender. Metadata messages never include secrets.

```ts
type FormCapture = {
  documentNonce: string; formId: string; username: string | null;
  password: string; intent: 'login' | 'signup' | 'change'; submitted: boolean;
};
// A sender-bound, unlocked generation must exist before values are accepted.
// Same-origin username-stage cache: 5 min. Candidate: 2 min. Pending: 30 min.
```

- [x] Avoid duplicate legacy submit listener; retain WebAuthn behavior and account picker. Add navigation/initialization notification restore and lifecycle cleanup.
- [x] Tests green; verify extension build serializes injected functions without module closures.

## Task 4 — Background capture and encrypted generator service

Files: new `capture-service.ts`, `generated-password-store.ts`, tests; `background.ts`, `application-rpc.ts`, `inline-accounts.ts`, `fill.ts`.

- [x] Write tests with real crypto and fake storage: account isolation, ciphertext contains no password, history retention, lock race, stale document, unchanged suppression, three pending cap, revision-bound save and dedupe, failure retry, field mismatch.
- [x] Run new tests red before service implementation.
- [x] Store pending records in restricted session, include random captureId/revision, account/generation/document/form/source. Expose sanitized previews; writes only trusted popup. Store generated history with authenticated encryption via existing crypto functions, including purpose/version/account/id in encrypted payload; retain 30 days/100 entries. Never write unencrypted secrets to local.

```ts
type CaptureChoice = { captureId: string; revision: number; action: 'save' | 'update'; itemId?: string; username?: string };
// During save, find latest item, validate source match and revision shown to user,
// merge only approved password/optional absent username, call VaultClient.saveItem.
// Generation: validate live document+form, encrypt history, fill and read back.
// History recovery: own source type; no live tab needed; never a fill capability.
```

- [x] Authenticate each content RPC with browser sender, restrict same-origin frames, reject payload-supplied source authorization. On lock/switch cancel outstanding generations, remove session captures, clear visible prompts; local encrypted history survives lock/switch, cleared on logout.
- [x] Keep completed capture results idempotent; handle uncertain network creation by sync+matching before any retry. Run background/RPC/session regression tests.

## Task 5 — Inline generator, notices and trusted capture review

Files: `inline-picker.ts` plus new inline generator/notice helper; shared capture review component; `VaultView.tsx`, `application/types.ts`, `application-client.ts`; generator history component/entry.

- [x] Add tests for generator visible at new-password input, default20/settings, confirmation pair, non-overwrite of old/manual values; notification snooze and no unchanged prompt; review target selection and history restore.
- [x] Implement masked nearby generator with explicit generate/fill and overwrite consent. Reuse existing overlay positioning/keyboard/dark theme. No secrets returned to inline UI. Non-modal corner notice uses captureId; explicit button opens popup review, with own extension tab fallback.
- [x] Extend BrowserActions with typed preview/save/dismiss and history metadata/reveal/delete/recover. Save options allow new or explicit matched target; show source and target account, retain pending on failure. Popup routes to requested capture ID, rejects expired IDs. History reveal/copy requires trusted UI and unlock; use existing clipboard cleanup.
- [x] Run UI tests green and relevant extension integration tests; commit reviewed components.

## Task 6 — Real browser validation and completion

Files: `scripts/e2e-extension.ts` or focused local smoke script; docs reference feature notes and plan progress.

- [x] Add local synthetic signup/login/change/redirect/SPA/multiple-form/same-origin-frame fixtures. Use trusted browser typing/clicks, synthetic data only.
- [x] Execute `bun run typecheck`, focused tests, then full `bun run test --testTimeout=15000`. On Windows use process-local TEMP/TMP under LOCALAPPDATA/Temp for Bun fixture builds.
- [x] Execute extension and Firefox builds, desktop/mobile frontend builds. Inspect welcome/dropdown and inline UI in a real browser, capture screenshots outside tracked source. Report browser-specific coverage accurately.
- [x] Run spec compliance review, resolve findings, then code quality review; repeat only checks affected by fixes.
- [x] Update docs with actual behavior and tested limits; commit scoped files, integrate with main without overwriting user work, push and verify upstream hash. Do not publish store packages as part of this task.


### Approved follow-up scope

- [x] QuickAccess locked account entry: large avatar + one email line, server URL in hover/accessibility text; horizontal wheel and keyboard navigation; selected account opens existing main-window unlock flow. User explicitly authorized subagent implementation and requested the simplified avatar treatment after running the first build.
- [x] ServerSpeed final user revision: remove disclosure/instruction panel; one line for latency/download/full test action. Welcome still prefetches only latency.
- [x] Superpowers installed and enabled in Codex (5.1.3).
- [x] Windows Release binary compiled and launched for user review; final visual revision rebuilt separately.


### Verification result

- Full suite: 182 files / 2190 tests passed (`--testTimeout=15000`, local TEMP/TMP for Windows Bun fixtures).
- Typecheck, Windows release binary, mobile frontend, Chromium extension and Firefox package builds passed. Existing Vite deprecation/chunk-size warnings remain.
- Local production Edge smoke: 25/25 checks. This smoke uses synthetic sessions; real server writes and worker restart were covered by module/integration tests rather than live-account smoke. Firefox runtime interaction was not exercised.
- Final quick layout: tested at CSS620×400 and360×400; 24px label height, 88px avatar, 96.8px hover avatar with no clipping. Server speed verified as one row before/after a full probe.
- Separate spec and code-quality reviews passed for server entry, quick navigation, capture domain/backend, observer/inline UI and trusted review/history. Browser-discovered SPA and focus regressions were fixed and rerun.
