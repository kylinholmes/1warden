# User details and encrypted account metadata

The account menu's single **用户详情** entry opens directly in the vault's main
content area, including compact windows. Its directory leads to personal profile
and device history, each with a back
button and breadcrumb. Profile is no longer a Settings tab. The existing marked secure note remains hidden from
ordinary 1Warden browse/search/reports. Other Bitwarden clients may show it.

## Record and ownership

Use `schema: 1warden.profile`, `version: 1`, and the new 1Warden marker. The fresh
application identity intentionally does not import the previous brand's profile
record or local caches. An optional `settings` object has its own
version (1), `preferences` and `devices`. Updating one section preserves the
others, unknown properties, item key and server metadata. Malformed/newer
schemas are never silently overwritten.

- Profile: display name and compressed avatar, automatically saved after a short
  typing pause / blur or confirming a crop.
- Preferences: `mode` (the choice, not resolved system brightness), palette ID,
  sidebar category grouping. Changes apply locally and automatically save into
  the encrypted note. Quick search, shortcuts, native permissions and
  window state remain device-local. Disabled placeholder settings are not saved.
- Devices: automatically register this installation after a verified unlocked
  sync. Store a random installation ID, coarse OS/client name and first/last use
  timestamps. Do not collect IP addresses, hardware fingerprints, raw UA strings,
  passwords, authentication tokens or vault keys. A desktop installation and a
  browser profile are separate installations. These are self-reported usage
  records, not authoritative active sessions or remote-revocation controls.

Device timestamps update on eligible unlock/open events, at most once an hour
per installation. Keep at most 10 recent installations, evicting oldest history
when a legacy large avatar leaves less room within the existing 7000-byte JSON
budget. This bound is disclosed in the UI. Do not alter an avatar or unknown
account fields merely to make space. A user-approved automatic device report may
create the special note even before the first profile edit.

All three workflows share a per-session write queue. Queued work rechecks the
unlock key and verified sync before writing. Preference edits compare their own
baseline so unrelated device/avatar updates do not cause a false conflict. The
underlying save still uses the server's `lastKnownRevisionDate`; stale remote
writes fail rather than overwriting newer data. A failed save is visibly reported,
not falsely marked synced. Refresh after a remote conflict by locking/unlocking.
App-owned drafts are scoped by server and email, survive in-app navigation and
are parked while locked or another account is selected. Rapid edits coalesce;
new edits during a write are retained. Saving/synced/failure status is explicit;
failed drafts support retry or discard. Drafts are memory-only, not guaranteed
to survive closing the application or extension popup. Page hide attempts to
flush pending writes. An incoming sync never schedules an automatic echo write.

## Navigation

The remembered-account picker is the home page on every platform. With no saved
accounts it says **添加服务器，开始使用** and **添加第一个服务器**. With saved accounts
it says **选择要连接的账户** and **连接其他服务器**. A deliberate
unfinished Add Account form can resume on popup reopen. Returning home does not
log out, discard vault data, or reset an unlocked account's deadline. Selecting
an already unlocked account reuses its session. Login/unlock back cancels pending
authentication and clears abandoned credential state. The vault sidebar has
no home or profile action; the account menu owns the single **用户详情** entry and
has no redundant **返回账户首页** action. Add-account and login/unlock flows retain
their explicit return path to the remembered-account picker.
Profile, import and security report have explicit return buttons. Appearance and
synced presentation preferences live only in Settings, not in user details.

Only validated presentation preferences are cached outside the unlocked vault,
partitioned by server/account. Display-name/avatar cache behavior is unchanged,
but all storage namespaces use the new identity.
Device history is absent from locked snapshots and is not written to the
presentation cache. Syncing appearance is a read-only projection, never an echo
write. Legacy local appearance seeds the first account; subsequent accounts use
their own settings/defaults. System mode follows each device's own system theme.

## Avatar editor

JPG/PNG/WebP up to 10 MB, decoded image up to 40 MP. FileReader `data:` input is
compatible with native `img-src 'self' data:`; the old blob URL was blocked by
that CSP. No policy is broadened. Drag or keyboard arrows reposition the crop;
the slider zooms 1–4×. Reset and Escape/cancel preserve the previous avatar.
The circular mask previews the eventual round display; output is cropped square
JPEG pixels, up to 128px, compressed to <=3600 characters to leave room for
metadata. Never upload the original source or its EXIF data. Confirming the crop
updates the profile draft and immediately starts its encrypted save.

## Verification

`bun run check` covers domain codecs, preference projection, device descriptors,
crop geometry, native-CSP-safe decoding, write ownership, lock/sync guards and
presentation-cache boundaries.

`ONEWARDEN_PUPPETEER=<puppeteer-core module> bun scripts/account-details-smoke.ts`
uses two isolated Edge profiles and a synthetic loopback vault to verify cropped
pixels, error/cancel behavior, encrypted writes, new-device appearance, device
history, stale-write refusal and popup layout. It also verifies empty/populated
home wording, production logo decoding under the real CSP, the account menu's
omitted home action and add-account/login/unlock return paths.

The navigation/branding follow-up passed 32 account-details checks, 30 profile
checks, 35 production Edge core checks, 25 connection-flow checks and 22 isolated
account-menu checks. `connection-smoke.ts edge` exercises the first-server form's
Back action, popup draft restoration and cancellation of late failed requests.

Add `--native` and `ONEWARDEN_NATIVE_EXE=<release exe>` to test the actual Windows
WebView2 upload/crop/save workflow and desktop-to-extension sync, including a
360px viewport. The script launches/terminates only its own test application and
never opens a personal vault. Firefox output is compiled; live Firefox/macOS/iOS
interaction testing is not implied by these checks.
