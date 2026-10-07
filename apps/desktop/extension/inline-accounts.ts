/** The only vault data that the long-lived page chooser may receive. */
export interface InlineAccount {
  id: string;
  title: string;
  username: string;
}

export interface InlineAccounts {
  unlocked: boolean;
  accounts: InlineAccount[];
}

export type InlineRequest =
  | { type: 'coffer:inline-accounts' }
  | { type: 'coffer:inline-fill'; itemId: string }
  | { type: 'coffer:inline-unlock' };

export type InlineReply = { ok: true } | { error: string };
