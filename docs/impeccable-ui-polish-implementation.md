# Impeccable UI polish implementation

Approved design specification: docs/impeccable-ui-audit-plan-2026-10-28.md. User requests sequential subagents to implement the approved polish, not further planning.

## Global Constraints

- Preserve current visual identity, factual Chinese copy, crypto/session guarantees, platform differences and 900px responsive rules. Do not touch user logo drafts or unrelated code.
- Use synthetic fixtures only; no actual vault actions, external account messaging, installation/restart or destructive operations.
- Read C:/Users/kylin/.codex/skills/impeccable/reference/craft-floor.md immediately before UI edits and follow polish.md. Context already loaded by controller; do not rerun it.
- Work only in C:/Users/kylin/orca/1warden/.superpowers/worktrees/impeccable-polish. Sequential execution, no subagents from workers. Commit only your own task files. Do not commit planning docs unless directed.
- Add meaningful behavioral tests for changed security/state/keyboard paths; avoid implementation-mirroring or cosmetic tests. Run focused suites and typecheck as relevant. Root controller handles final full-suite, rendered matrix and detector.
- Report full detail in the assigned task report, short status in final response. Do not leave required work as future suggestions; ask the controller early for concrete blockers.
- User steering during Task4: default blue looks gray; add all three proposed palette directions as selectable themes (teal/warm-white, clear blue/white, ink/cream/brass) with authored light/dark pairs. Retain existing themes and persisted selections so user can try them before choosing a permanent default. This explicitly authorizes the additional palette work in Task6.

## Task 1: Editor secrets, field clarity and compact new-entry flow

Address A01, A09, A10 plus approved editor first-screen proposal.
Native secret fields (passwords, TOTP seeds, PIN/security codes, confidential identity/account fields per existing model) must be masked initially; revealing/hiding uses field-specific accessible names and preserves draft values. SSH private keys require explicit reveal without losing multiline editing. Public SSH keys remain readable. Generated passwords and newly added secret fields remain masked. Reuse existing patterns, respect busy/disabled behavior and do not serialize reveal UI state.
Name is required: associate validation text with input, focus/scroll name on empty submission; preserve existing network-failure retry focus behavior. Detail SecretField reveal buttons identify the field and expose toggle state.
At compact widths use a one-row current type selector with full choices available on demand, instead of eight cards occupying the first screen. Preserve per-type drafts and existing desktop grid. Keep current 900px logic and fixed footer. Ensure core login fields can appear in the first 390x700 viewport.
Likely files: packages/ui/src/ItemEditor.tsx, item-editor-fields.ts, SecretField.tsx, a small focused secret editor component if useful, related interaction tests. Keep changes narrowly scoped.
Acceptance: default masked for existing/new/generated secrets, reveal/hide editable without changing saved values, private key preserved, name error positioned/associated, compact selector supports keyboard and retains switching drafts. Test relevant existing editor, field and save behavior.

## Task 2: Trustworthy and actionable security report

Address A02 and A06; improve report hierarchy without redesign.
After breach checks, score, grade, summary and findings use one consistent full report. Retain opt-in HIBP behavior, loading/error recovery and stale/account-switch guards. Add direct per-item navigation from weak/breached/unsecured/expiring findings and expansion/navigation for reused groups. Navigation to detail and back must preserve report scroll and current breach state; no manual name search. Avoid materializing new secret data in shared display contracts.
Shorten the default technical opt-in explanation using disclosure while preserving all facts and opt-in. Keep current score and risk semantics, no decorative dashboard.
Likely files: application/types.ts/service.ts, screens/SecurityReport.tsx/VaultView.tsx, packages/ui/src/SecurityReportView.tsx and relevant health/report tests.
Acceptance: ten otherwise clean records + one breach produces score70 consistently, all finding types can open their item, back preserves report state, late responses cannot update another account. Add meaningful behavioral tests.

## Task 3: Safe update restart coordination

Address A03. Introduce minimal shared safe-leave/restart coordination that can handle updater hosts both outside App providers and inside Settings. Both notice and settings restart routes must flush profile autosave, surface failure without leaving, and obtain explicit draft save/discard/cancel for open item edits using existing editor confirmation conventions. An overlay must not bypass the check. Preserve prepared-update state, later/retry/manual behavior, platform gating and no automatic restart.
Avoid copying secrets into a global generic draft store. Keep coordinator subscriptions scoped/cleaned and protect duplicate async requests and unmount/account changes. Do not actually restart the machine/app during validation.
Likely files: components/AppUpdateHost/Notice/AppUpdates, App/ProfileAutosave/ItemEditor integration plus a focused shared coordinator if needed. Task1 editor behavior must remain intact.
Acceptance: ready+dirty edit cannot restart immediately; cancel keeps draft; discard explicit; failed profile save blocks; successful flush calls restart exactly once; no-update/no-draft behavior still works. Focused tests use fake updater.

## Task 4: Vault and quick-search accessible navigation

Address A04, A07, A08, A14, A20 and destination semantics of A18 where relevant.
Vault sorting must expose current choice and support opening, arrows/Home/End as appropriate, Escape and focus restoration; reuse shared Select where possible. ItemRow current item and favorite have accessible meaning without inventing an incomplete listbox model. Empty states offer matching next actions for empty-vault/folder/favorites/search.
Quick search must make active result while input holds focus accessible via a complete combobox/listbox model or equivalently valid pattern; stable IDs, selected state, result count/no-results status. Preserve keyboard copy and existing action semantics; do not put nested interactive buttons inside an invalid option. Locked account cards display server host/path below email, retain truncation and navigation.
Use appropriate main/h1 semantics at destination boundaries; shared PageHeader also serves dialogs and must not blindly force h1 or multiple main. Keep compact drawer, scroll/selection and 900px behavior.
Acceptance: keyboard sorting closes on Esc and restores focus, input knows current quick result, selection follows filtering and clamping, same-email accounts distinguish visibly, empty action works and respects selected category. Focused navigation/quick tests.

## Task 5: Transfer and browser credential state feedback

Address A11, A12, A13, A15, A16 and remaining A18.
BulkDelete/TrashView/BrowserCredentialReview must provide stable focus and concise status after preview/confirm/restore/save/ignore, next card/row or title when removed, original control on recoverable failure. Preserve account isolation, revision checks, dangerous action scopes and existing confirmations.
Import preview/progress/result/partial failure states: semantic stage headings, focus on meaningful transition, short live summaries for counts and failures, avoid live entire error lists. Add appropriate main/title at destination not shared global header. Collapse long format-help content while keeping key risk/file limits discoverable. Retain encrypted export default and current behavior.
Credential review must use existing valid surface/border tokens and .field. Inline credentials arrival gets a polite notification without stealing host-page focus. Inline picker failure restores active button/input for Enter retry on Chromium/Firefox rather than only re-enabling controls.
If large import exception lists are touched, defer DOM creation and batch/list pagination to keep large results accessible without removing total counts/reasons; no speculative global virtualization.
Acceptance: complete/fail/retry paths remain keyboard-continuous, initial webpage prompt is announced, successful card removal has next focus, multiple cards work, no true user data or real transfers used. Focused behavioral tests.

## Task 6: Shared visual and responsive finish

Address A05, A17, A19 and verify cross-module polish.
Necessary controls get a semantic border token reaching >=3:1 against adjacent surfaces in every supported palette/theme. Decorative borders keep current light hierarchy; don't darken all cards. Fix generator narrow rows at320px: labels above, options two columns or natural wrap, no one-character columns; retain desktop structure. Keep short strength summary ahead of detailed explanation without changing facts.
Replace global reduced-motion 0.01ms kill with intentional handling: remove substantial movement, preserve state feedback and presence cleanup, loading has explicit ongoing text/static indicator. Audit affected animations rather than disabling feedback blindly.
Check touched forms/panels/layout after Tasks1-5, remove accidental duplicate borders/spacing drift only within approved scope. Keep existing toast semantic accent unless real defect. No rebrand or new speculative features.
Root interim rendering also found the390px detail header clips even the short name GitHub to Gi… because actions consume most width. Adjust the compact header composition so ordinary short names remain legible while keeping edit/delete/favorite available; do not drop actions or change their semantics. Check reduced-height and long-title variants too.
User additionally approved adding three selectable palettes to the existing picker: jade/青绿暖白 (clear deep green action, warm-white paper, no gray-blue cast), clear-blue/清透蓝白 (crisp cobalt action, near-white surfaces and high clarity), brass/墨色黄铜 (warm cream paper, ink text and brass actions). Author matching dark palettes; do not mechanically invert them. Preserve all existing palettes, IDs and persisted choices; no forced preference migration. Use existing paletteTokens/picker architecture. Keep privacy/security semantics and category colors distinct enough with redundant icons/text. All twelve palettes x two modes must meet the required contrasts for text, controls and focus. Root will provide preview feedback; treat this as current approved scope, not speculative rebrand.
Acceptance: 320/390/899/900/1280 layouts, light/dark + supported palettes, focus/error/busy/long-content states; native checkbox exceptions correctly considered. Run relevant theme/layout/generator tests and builds. Controller performs final rendered matrix and one detector scan.
