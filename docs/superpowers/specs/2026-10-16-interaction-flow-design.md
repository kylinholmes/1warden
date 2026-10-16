# Interaction continuity and in-place quick unlock

The user explicitly requests a complete quick-window unlock journey and an interaction audit of the other main journeys. Existing authorization includes implementation, compiling, launching, committing and pushing. This revision follows that direction without adding another approval round.

## Quick access

The complete journey stays in the quick window: remembered account → password → optional two-step verification → search → copy. One remembered account goes directly to the password form; multiple accounts start with large avatar choices and one email line. The selected account's email and server remain visible during authentication. Selecting an already unlocked account resumes search without asking for a password.

Password mistakes and connection failures show inline feedback and restore input focus. Duplicate submissions are blocked. Back from verification returns to password; back from password returns to account choices. Escape follows that same back path, then closes from account selection/search. With only one account, Escape from password closes. Closing or returning cancels pending authentication, clears secrets, and ignores stale results. A hidden/reopened window must not accept a response from the previous opening. Success focuses search and preserves an interrupted query; it never executes the copy-success auto-hide path.

The main webview remains the session/key owner. Quick holds only transient user-entered credentials and item summaries. A native, caller-checked, one-shot mailbox accepts quick authentication requests and lets only main consume them. Event notifications contain request identifiers, not credentials. Requests bind to opening generation, account and operation. Cancellation invalidates the captured vault's pending authentication without locking another account. Existing server password validation and two-factor policy remain in force; this is not a new offline-unlock policy.

An explicit login action may open main when there are no remembered accounts. Routine remembered-account unlock never opens main. Search exposes account selection so a user can reach another account without leaving quick access.

## Interaction audit

Check actual code and walk through: welcome/login/register/server choice; account switching and lock/unlock; search/copy; create/edit/save/cancel/delete; password generator; browser credential suggestions and review. For each check entry, completion, recoverable failure, cancellation, focus and task continuation. Report demonstrated defects with trigger and expected behavior; do not substitute visual polish or speculative feature lists for this audit. Fix high-confidence journey interruptions and add targeted regression coverage.

## Evidence and alternatives

- https://support.1password.com/quick-access/ describes retrieving items without leaving the current app and choosing account scope in Quick Access. It does not document the precise locked-password UI. Our inline unlock is a design decision based on the user's requirement, not an asserted clone.
- https://bitwarden.com/help/understand-log-in-vs-unlock/ distinguishes login and unlock. Our implementation still uses the repository's existing authentication behavior, which may require server validation and a second factor.
- Rejected: foregrounding main after choosing an account, because it breaks the requested task. Rejected: duplicating vault sessions in quick, because that adds a second authentication and synchronization owner.

## Validation

Regression coverage must exercise successful in-place unlock, wrong-password retry, two-factor continuation, back/cancel, switching accounts during an outstanding request, close/reopen stale response, unlocked-account selection and restored search focus. Use synthetic accounts in real Edge/WebView previews at desktop and narrow sizes; never enter a user's real password in automation. Run focused and repository checks, native build and launch the refreshed executable. Record any platform/runtime gaps accurately.
