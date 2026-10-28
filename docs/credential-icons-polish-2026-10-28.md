# Credential details and secure-note icons

The login detail now omits the passkey row when the saved credential array is missing or empty. Records with saved credentials retain the count, relying-party name/domain, account information, creation date and confirmed deletion. A failed removal keeps the saved credential visible.

Secure notes use a quiet tinted tile with a title abbreviation and a small note marker, as selected by the user. The shared component covers the desktop, quick search and extension surfaces. List and detail tiles retain their 34px and 36px dimensions. Both icon artwork settings use this presentation; official service/card logos and all existing palettes remain unchanged. Note icons never request a website favicon.

## Windows test-window cleanup

`Smoke login` is a synthetic test-page title. Headless Edge can expose hidden, zero-size windows to window inventories. Native tests also start an isolated 1Warden/WebView process. Previously browser shutdown had no shared bounded fallback, and native cleanup killed only the main process.

The shared smoke helper tracks handles created by the test itself. Disposable Windows test browsers terminate their owned process tree before closing the debugger transport, preventing the root from exiting ahead of hidden children. Transport shutdown has a five-second deadline and a final cleanup attempt. Native tests disconnect the debugger and terminate their owned application tree. Exit and interrupt handlers also clean registered processes; no cleanup selects applications by image name. The same helper is used by the screenshot and legacy extension runners. Non-Windows forced cleanup terminates the owned root; the Windows tree behavior is the scope of this fix.

One orphaned headless Edge process was confirmed by its disposable Puppeteer profile and missing parent, then its specific process tree was terminated. After the updated real Edge and native runs, no test-owned Edge, 1Warden or corresponding WebView processes remained.

## Verification

- Typecheck and workflow policy validation passed.
- Full unit suite: 202 files, 2409 tests passed.
- Appearance browser checks: 129 passed, including all 13 palettes in light/dark, note-icon contrast and marker separation, 360px note details and 360/720/1080px passkey details.
- Built production Edge extension: 114 checks passed.
- Windows production build passed; actual native background-sync regression: 9 checks passed.
- Six process-cleanup tests cover graceful close, rejected/hung close, runner exit/interrupt and attached-WebView disconnection. Windows rejected/hung cases verify the child process tree is gone.
- Rendered screenshots reviewed for both light/dark Blue Whale note details and list tiles. Only synthetic fixtures were used; personal vault data and logo drafts were not changed.

Local evidence is retained under `artifacts/credential-icons-2026-10-28` and the corresponding `artifacts/credential-icons-*.log` files (ignored by Git).
