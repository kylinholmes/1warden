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
  | { type: '1warden:inline-accounts' }
  | { type: '1warden:inline-fill'; itemId: string }
  | { type: '1warden:inline-unlock' };

export type InlineReply = { ok: true } | { error: string };
