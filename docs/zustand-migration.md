# Zustand migration

## Contract

Replace React-managed application/UI state with Zustand across desktop, mobile,
extension, shared components and previews. Preserve existing instance/account
lifetimes; never persist passwords, OTPs, decrypted drafts or reveal values.
DOM refs, cancellation tokens and effects remain React refs/effects. Context may
inject a stable, scoped store, but must not carry mutable state snapshots.
The cryptographic/session domain and browser/Rust protocols are not being
redesigned; the UI presentation store must retain their lock/cancellation rules.

Use pinned Zustand 5.0.15. A shared vanilla/React package separates non-React
consumers from view subscriptions. Components own local stores, not global
singletons. Shared stores use selectors and immutable snapshots.

## Baseline / predecessor delivered

Home navigation, independent profile directory and autosave are complete.
`bun run check`: 92 files / 1119 tests passed. Edge account details 24, native
account details 20, profile multi-account 29, browser core 30, menu 20,
appearance 45, cross-build width/layout 490 checks passed. Windows EXE updated
2026-10-08 16:12:13; Edge/Firefox JS updated 16:10:38. Mobile frontend built.
No installer/archive or personal vault mutations.

## Judge

- Static scan: no React useState/useReducer/useSyncExternalStore state owners.
- Unit/type checks incl. isolation, stable snapshots, no-op setters, teardown,
  lock deadlines, metadata conflict/write guards and secret lifetimes.
- Build all platforms; run browser/core, profile, account details, menu,
  appearance, modal motion and cross-width smoke; native quick/profile smoke.
- Review complete migration diff, without reverting unrelated existing changes.
- Maximum identical no-evidence retries: 2; diagnose before a third attempt.

## Progress

2026-10-08: migrated component/form/dialog state, theme/display preferences,
application snapshots, updater snapshots, profile autosave snapshots, navigation
and metadata contexts. Temporary migration generators were removed after review.
`@1warden/state/react` provides one scoped vanilla store per mounted owner,
field selectors/actions, and a zero-copy adapter for the existing controller
snapshot protocol. Context only injects fixed stores/controllers or action APIs.
No new persistence or devtools middleware is used. The class error boundary
keeps its fallback state in Zustand and uses React's required lifecycle.

Review found a navigation race: the session is cleared synchronously during an
account switch, which briefly mounted Connect and created a false blank login
draft. App now renders a pending switch view until the operation settles. The
multi-account smoke explicitly asserts that switching creates no draft.

Completed verification:

- `bun run check`: 94 files / 1122 tests; includes an AST guard against React
  state ownership returning to any frontend target.
- Zustand/React development-mode smoke: 13 checks (StrictMode cleanup, selectors,
  functional updates, scoped/late-write isolation, keyed remount, initial and
  update render error boundaries).
- Edge extension: account details 24; multi-account profile 30; core/search/fill
  30; menu 20. All use synthetic loopback data and disposable browser profiles.
- Appearance 45; retained panel motion 58; width/layout 490 across desktop,
  mobile and extension previews. Height/orientation never overrides width.
- Edge/Firefox extension and mobile frontend builds pass. macOS/iOS/Android
  native builds and Firefox runtime are not tested on this Windows host.

Windows validation completed: 20 native account-details checks and 12 native
quick-window checks (hotkey registration, transparent roots, locked Escape,
blur dismissal, temporary pin reset, enable/disable, caller permissions).
The clipboard-replacement opt-in was not run. Test processes were stopped and
original native quick settings restored; no personal vault was accessed.

Historical migration artifacts (2026-10-08, local time; superseded by the fresh
identity and navigation work documented in `brand-and-navigation.md`):

- Windows pre-rename binary: 16:39:10, 6,484,992 bytes.
  `bun run build:windows -- --no-bundle -- --locked --offline`.
- Edge `apps/desktop/dist-extension`, Firefox `apps/desktop/dist-firefox`,
  popup JS 16:36:50. `bun run build:extension-firefox`.
- Mobile frontend: `bun run build:mobile`.
- Native reports: `C:\ProgramData\Temp\1warden-account-details-LTMPfh` and
  `C:\ProgramData\Temp\1warden-native-quick-gOOCA5`.

Migration and combined-diff review complete; `git diff --check` passes.
Cargo target-dir is unchanged; no installer or archive was created.

## Implementation reference

Scoped vanilla stores and fixed Context injection follow the
[official Zustand guidance](https://github.com/pmndrs/zustand).
Business/service cryptography, queues and cancellation resources are unchanged;
the migration changes ownership and subscriptions of React-visible state.
