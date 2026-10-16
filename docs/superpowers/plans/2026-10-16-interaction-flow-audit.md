# Interaction flow implementation plan

> Execute continuously using Superpowers implementation and independent review. The user has authorized implementation and delivery.

**Goal:** Complete authentication inside Quick Access and repair demonstrated interruptions in the main user journeys.

**Architecture:** Main retains vault sessions. Native commands carry transient authentication to main through a one-shot mailbox. Quick renders a cancellable account/password/verification/search state machine. Existing application and shared UI components remain the source of authentication and two-factor behavior.

**Tech stack:** React, Zustand wrapper, TypeScript, Tauri/Rust, Vitest/Bun, Edge smoke tests.

- [x] Audit entry and vault/browser journeys; write concrete findings and reproducible acceptance checks.
- [x] Add native caller/generation validation, main authentication coordinator, cancellation, and narrow TypeScript protocol. Files: `src-tauri/src/quick_auth.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/quick.rs`, `src/quick-auth.ts`, `src/quick-auth-coordinator.ts`, `src/use-quick-auth.ts`, `src/main.tsx`. Tests cover stale/removed identity, wrong password, second factor, cancellation and account-switch races.
- [x] Implement quick account/password/verification/search UI in `src/screens/QuickAccess.tsx`, `src/components/QuickLockedAccounts.tsx`, `src/components/QuickUnlockPanel.tsx`, `src/quick/Quick.tsx`, with `src/quick/main.tsx` as bootstrap. Maintain large avatars, clear account identity, inline error, keyboard back/escape, and preserved query. Extend preview and interaction tests to execute the whole journey.
- [x] Fix demonstrated audit defects with focused behavioral regression tests; record scope and exclusions in the audit report.
- [x] Review behavior against the design, then review code quality and security boundaries independently. Resolve findings before delivery.
- [x] Run typecheck, focused/full tests, real-browser interaction smoke and native release build. Launch refreshed preview.

Delivery: commit, merge and push under standing authorization. See `../specs/2026-10-16-interaction-audit-results.md` for findings and verification.
