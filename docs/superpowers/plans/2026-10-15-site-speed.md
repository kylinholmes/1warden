# Entrance site measurements

The user chose automatic latency measurement and manual full measurement. Keep login independent of the measurement, and share the control across saved accounts, custom servers, Vaultwarden, Bitwarden US/EU, and registration.

- [x] Debounce valid site changes; automatically take three public configuration request samples and display their median round-trip time.
- [x] Add a non-submit button for full latency and download measurement, with cancellation and stale-result suppression.
- [x] Download only public same-origin static resources, with no account credentials; preserve cloud API routing and self-hosted installation paths.
- [x] Bound each request in both the shared helper and native HTTP bridge: 4/8-second deadlines, bounded response reads, and about 4 MiB aggregate payload per full run.
- [x] Show effective download MB/s only when resource size and elapsed time support it. Explain missing/too-small/too-fast samples without blocking login.
- [x] Cover invalid URLs, errors, redirects, compression, cancellation, late completion, native size limits, and login-form behavior.
- [x] Add real Vaultwarden probe checks before account registration in the existing isolated protocol smoke.
- [x] Review desktop/narrow entrance and saved-account unlock screenshots. Preview uses synthetic probe responses instead of contacting public sites.
- [x] Independent code review: no critical or important findings remain.
- [ ] Complete browser regression, push main, and verify that main CI alone triggers the automatic patch release.

## Verification

- `bun run check`: 168 files, 2,041 passed, 2 pre-existing skips.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: 61 passed, 4 existing ignored integration tests; existing biometric naming warnings remain.
- `bun run check:ci`: passed.
- Extension and mobile production builds: passed.
- Local `https://localhost:8443` Vaultwarden: 34 protocol checks passed, including anonymous latency/full measurements and existing account migration/import/delete behavior. The local-only self-signed certificate bypass is confined to the smoke process; product certificate verification remains enabled.
- Three public presets returned valid latency samples. Compressed responses lacking a trustworthy transfer size return an explanatory download note.
- Vaultwarden.com with the native client's uncompressed representation returned a 280,311-byte sample and about 0.22 MB/s during the local diagnostic; this is a sample result, not a persistent service benchmark.
- `.dev/site-speed-visual.ts`: automatic latency only, manual download reference, enabled login, desktop/narrow layouts, and saved-account unlock passed without runtime errors. Screenshots under `.dev/site-speed-visual/`.
- `bun run test:ui ui`: all 10 stages passed; evidence at `/var/folders/3_/03n880191ld4n90h_6xtyk880000gn/T/1warden-ci-ui-gTGes1/summary.json`.

## Measurement semantics

Latency includes HTTP request/response and native bridge overhead. Download reference includes full request time; it is not peak link bandwidth or vault synchronization speed. CDN responses are valid network samples; unique query strings and `cache: no-store` prevent browser cache reuse. Complete compressed responses use a validated Content-Length when available, while decoded buffers also remain bounded.

Native cancellation immediately stops JavaScript waiting and discards late results. An already dispatched Rust request finishes or reaches its configured deadline and size limit.
