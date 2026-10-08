# Complete Item Editing Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement and review the independent tasks below.

**Goal:** Complete the existing item editor and resource actions without losing saved fields; render record metadata as compact secondary text.

**Architecture:** Keep the shared React editor and application service used by desktop and extensions. Preserve server fields at the vault/API boundary, use explicit operations for attachments and credential/history removal, and keep secret material out of detail projections.

**Tech Stack:** TypeScript, React, Zustand, Bun/Vitest, Tauri, Vaultwarden API.

**Spec:** User-approved conversation scope: all gaps identified in the editor audit, data-loss bug fixes, compact record information. No tags. Existing native Bitwarden fields and custom fields remain the data model exposed to users.

## Global Constraints

- Work in the existing feature branch and preserve the preceding uncommitted detail/folder changes.
- Test using synthetic fixtures and the authorized localhost Vaultwarden account only; never alter personal vault data.
- Shared UI must work in Edge, Zen, and Apple Silicon macOS.
- Unknown server fields must survive ordinary edits where supported; refuse unsafe saves instead of silently discarding undecipherable data.
- Account switching or locking invalidates pending operations. No decrypted vault persistence.
- Passkeys are created by a website registration ceremony, not by fabricating credential rows. Provide a site entry point plus metadata and explicit removal.
- Password history is generated from real password changes; allow inspection and explicit clearing, not invented history entries.

## Review Focus

- Editing/deleting one URL must retain other URLs, match rules, and nested metadata.
- Existing boolean/linked custom fields must remain valid through type changes; unsupported fields must survive unchanged.
- Failed attachment upload must clean up its temporary ticket and never appear successful.
- Simultaneous writes and account changes must not apply stale responses or resurrect removed credentials.
- Wide/narrow layouts must keep actions reachable and metadata unobtrusive.

### Task 1: Complete editable fields (editor agent)

- [ ] Extend `packages/ui/src/ItemEditor.tsx`, extracting focused editor helpers/components as useful.
- [ ] Implement multi-URL add/edit/remove and per-URL matching; custom text/hidden/boolean/linked controls and valid linked targets.
- [ ] Expose full card/identity fields and supported login preferences; preserve unmodified input values.
- [ ] Add meaningful behavior regression checks for multi-value edits and custom field transitions.

### Task 2: Lossless model and serialization (preservation agent)

- [ ] Update vault model/decrypt/encrypt and API cipher serialization to retain unedited server fields and metadata.
- [ ] Expose helper(s) for application-service draft merging that preserve ownership and unreadable-field safety.
- [ ] Test known and unknown nested fields, URL/custom array deletion, unsupported data, independent keys, and identity ownership.
- [ ] Coordinate exact helper/type interfaces with the parent and Task 3; do not edit `client.ts` or application files.

### Task 3: Vault resource operations (backend agent)

- [ ] Complete real attachment upload/download/delete and cleanup using verified Vaultwarden endpoints.
- [ ] Add guarded `deleteAttachment(id, attachmentId)`, `removePasskey(id, credentialId)`, and `clearPasswordHistory(id)` operations.
- [ ] Update save behavior to maintain password revision/history correctly, serialize record writes as needed, and preserve backend metadata.
- [ ] Own `packages/vault/src/client.ts`, attachment API/helpers and tests; coordinate with Task 2.

### Task 4: Integration and presentation (parent)

- [ ] Wire new operations through application service, client, extension RPC validation, and account/session boundaries.
- [ ] Add attachment upload/delete, passkey metadata/removal/site entry, and history clearing controls with inline confirmation and error handling.
- [ ] Render record metadata as small secondary text with a compact ID copy action; avoid copying placeholder values.
- [ ] Add bridge and browser regressions; run typecheck/unit checks, real Edge/Zen UI, local server round-trip checks, and layout checks.
- [ ] Review all tasks, fix material findings, rebuild arm64 app, and restart the existing instance after checking for unsaved edits.
