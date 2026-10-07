# 1Warden desktop updates

The user requests automatic downloads followed by a small restart prompt, similar to 1Password. They explicitly chose to make `kylinholmes/1warden` public so applications can fetch GitHub Releases without credentials. Only Apple Silicon macOS is shipped.

Use the official Tauri 2 updater with its minisign verification, as a deliberate exception to the earlier no-plugin implementation guideline. The existing bundle identifier stays `app.coffer.desktop`. A main-window, macOS-only capability permits update operations; a native `restart_app` command allows explicit restart. Mobile, extension and quick-panel builds do not start an updater.

After a 10-second startup delay and every six hours, check the public release `latest.json`. Download and install a verified newer bundle in the background; on macOS this replaces the on-disk bundle while the running application continues. Never quit automatically. Ready state prevents repeated downloads. A small politely announced notification offers “稍后” and “重启更新”; dismissal leaves the restart action in Settings. A restart failure remains retryable. Settings also show the running version, check/progress/error status and manual retry.

Version metadata and platform selection are validated. The updater archive is `.app.tar.gz` with its generated `.sig`, distinct from manual DMG/app-ZIP assets. Enable signed-version verification only if both pinned updater and CLI support it. Reject invalid signatures and downgrades. Only trusted version-tag builds receive `TAURI_SIGNING_PRIVATE_KEY`; branch/PR/manual builds disable updater artifacts and never require the secret. Private keys live outside Git and in GitHub Secrets; the config contains only the public key.

Tagged CI publishes ARM64 manual packages, the signed updater archive/signature and a `latest.json` with `darwin-aarch64`, version, timestamp and public download URL. Source versions and tag must agree. UI tests cover duplicate requests, failures, progress, postponement and explicit restart; native verification checks signatures and tampering. Tests use disposable bundles and never restart the user's running app or touch their vault.
