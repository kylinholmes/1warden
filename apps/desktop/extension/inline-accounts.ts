/** Labels and short-lived TOTP previews; passwords and TOTP seeds stay in background. */
import type { InlineTarget } from './inline-fields';
export interface InlineOtp { code: string; period: number; expiresAt: number }
export interface InlineAccount {
  id: string;
  title: string;
  username: string;
  otp?: InlineOtp;
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
