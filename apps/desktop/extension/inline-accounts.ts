/** The only vault data that the long-lived page chooser may receive. */
import type { InlineTarget } from './inline-fields';
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
  | { type: '1warden:inline-accounts'; target?: InlineTarget; nonce?: string; documentUrl?: string }
  | { type: '1warden:inline-fill'; itemId: string; target?: InlineTarget; nonce?: string; documentUrl?: string }
  | { type: '1warden:inline-unlock' };

export type InlineReply = { ok: true } | { error: string };
