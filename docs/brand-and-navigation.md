# Fresh identity and navigation cleanup

## Contract

User approved a fresh application/extension identity with no old-brand migration,
including reauthentication and device-setting resets. Preserve existing vault
records and local data; do not delete user data or alter encryption. The new
profile marker/schema recognizes only the new special record; a previous-brand
profile note can appear as an ordinary secure note. No compatibility aliases.

Names: visible `1Warden`, workspace `@1warden/*`, native identifier
`app.onewarden.desktop`, Rust package `onewarden`, Rust library `onewarden_lib`,
executable `1warden.exe`. Rust/shell identifiers cannot start with a number, so
environment variables use `ONEWARDEN_*` and code/CSS identifiers use `onewarden`.
IPC, storage and encrypted-profile namespaces use `1warden` consistently.
The global Cargo target-dir is unchanged. iOS sources, project and schemes have
matching renamed paths; app product references match `1Warden.app`.

Chromium has a new fixed public manifest key; unpacked extension ID is
`eceecdljohcknjkdfllnjlifehffcain`. No private signing key is stored.
Firefox uses `1warden@1warden.app` and strips the Chromium-only key.
Disable the previous extension before loading the rebuilt directory. This task
does not publish extensions or updates, change store listings, or install drivers.

The frontend design pass retains the existing palette, spacing and component
language and removes competing navigation entries:

- Sidebar: vault navigation only, no Home or Profile destination.
- Account trigger: one current avatar. Open menu: compact text identity, other
  accounts, Add Account, User Details, Settings, Logout. The redundant Return to
  Account Home action was removed in the subsequent navigation pass.
- User Details: profile editor and device history, in the main content area.
- Appearance and synced presentation preferences: Settings only. Autosave,
  encrypted synchronization and existing failure/retry behavior are preserved.
- Connection/add-account and unlock flows retain a route back to account home.
  Vault menus do not repeat that destination. Subpages retain Back and
  focus restoration; width below 900 CSS px uses compact navigation on all builds.

## Verification, 2026-10-08

- Frozen Bun install; `bun run check`: 95 files / 1126 tests pass.
- Rust library: 41 passed / 2 intentionally ignored integration checks.
- Edge production extension: core/search/details/fill 31; multi-account profile
  30; account details 26. The real installed extension ID matches the manifest key.
- Account menu 22; appearance 45; panel motion/focus 58; responsive layout 490 across desktop, mobile and
  extension previews. Menu hover does not open it; keyboard and focus checks pass.
- Windows release EXE: account details 22, including actual upload/crop/save,
  desktop-to-extension encrypted sync, and a 360px viewport. Quick window 12 checks.
- Edge/Firefox extension and mobile frontend builds pass. Windows native release
  built with `bun run build:windows -- --no-bundle -- --locked --offline`.
- All runtime tests use synthetic loopback data and disposable profiles. No
  personal vault was accessed; clipboard-replacement opt-in was not run.
- Source/filename scan is case-insensitive, includes ignored source/scaffolding,
  excludes Git history, dependencies, caches and generated build outputs.
  Old-brand matches: zero. `git diff --check` passes.

An initial new Cargo wiring assertion incorrectly assumed no comment between a
section header and its name; the test now strips comments before checking, without
weakening the expected crate/library/binary names. Native build and tests validate
the actual configuration separately.

macOS/iOS/Android native runtime and Firefox runtime are not tested on this Windows
host. Existing worktree changes are retained; no installer or archive was created.

## Outputs and reports

- Windows: `C:\ProgramData\Temp\target_cache\x86_64-pc-windows-msvc\release\1warden.exe`.
  Built 2026-10-08 16:55:56 (local time), 6,484,992 bytes.
- Edge: `apps/desktop/dist-extension`; Firefox: `apps/desktop/dist-firefox`.
- Edge core: `C:\ProgramData\Temp\onewarden-browser-smoke-1791449861514`.
- Edge profile: `C:\ProgramData\Temp\onewarden-profile-artifacts-edge-6eEUow`.
- Edge account details: `C:\ProgramData\Temp\1warden-account-details-Xn6NlN`.
- Native account details: `C:\ProgramData\Temp\1warden-account-details-FWAy6Y`.
- Native quick: `C:\ProgramData\Temp\1warden-native-quick-dnZPPQ`.
- Menu / appearance: `C:\ProgramData\Temp\1warden-brand-menu` and
  `C:\ProgramData\Temp\1warden-brand-appearance`.
- Layout: `C:\ProgramData\Temp\onewarden-layout-1791449833041`.
- Motion/focus: `C:\ProgramData\Temp\1warden-brand-motion`.
