import type { VaultClient } from '@1warden/vault';
import { accountKey } from './application/account-target';
import type { QuickAccount } from './quick-bridge';
import type { QuickAccountNavigation } from './quick-accounts';
import type { QuickAuthCancellation, QuickAuthKey, QuickAuthRequest, QuickAuthResult } from './quick-auth';
import { twoFactorChallenge, twoFactorErrorMessage } from './screens/auth-error';

interface Options {
  getActiveVault(): VaultClient;
  subscribeActiveVault(listener: () => void): () => void;
  subscribeVaultChanges?(listener: () => void): () => void;
  loadAccounts(): Promise<QuickAccount[]>;
  openAccount: QuickAccountNavigation;
  refresh(): Promise<void>;
  isCurrent(key: QuickAuthKey): Promise<boolean>;
  reply(result: QuickAuthResult): Promise<boolean>;
}
interface Selection {
  generation: number;
  accountId: string;
  vault: VaultClient;
  version: number;
  selecting: boolean;
  switched: boolean;
  stage: QuickAuthResult['stage'];
  accepted?: boolean;
  pendingRequest?: number;
  providers?: number[];
  authentication?: ReturnType<VaultClient['captureAuthentication']>;
}

/** Main owns both the selected session and every password/OTP operation. */
export function createQuickAuthCoordinator(options: Options) {
  let disposed = false;
  let version = 0;
  let selected: Selection | null = null;
  let current: QuickAuthKey | null = null;
  const nativeCurrent = (key: QuickAuthKey) => options.isCurrent({ generation: key.generation, requestId: key.requestId });
  const matches = (vault: VaultClient, id: string) => {
    const account = vault.getSession().account;
    return account !== null && accountKey(account) === id;
  };
  function invalidate() {
    const previous = selected;
    selected = null;
    // Switching away preserves an already-unlocked parked session. Explicit
    // native cancellation separately distinguishes unaccepted success below.
    previous?.authentication?.cancel();
  }
  const stop = options.subscribeActiveVault(() => {
    version++;
    const vault = options.getActiveVault();
    // A guarded selection owns exactly one switch to its requested identity.
    if (selected?.selecting && !selected.switched && matches(vault, selected.accountId)) {
      selected.vault = vault; selected.version = version; selected.switched = true;
    } else invalidate();
  });
  function localCurrent(key: QuickAuthKey, selection?: Selection) {
    return !disposed && current?.generation === key.generation && current.requestId === key.requestId
      && (!selection || (selected === selection && selection.version === version
        && selection.vault === options.getActiveVault()));
  }
  async function assertCurrent(key: QuickAuthKey, selection?: Selection) {
    if (!localCurrent(key, selection) || !await nativeCurrent(key) || !localCurrent(key, selection)) {
      throw new Error('认证已取消，请重新选择账户');
    }
  }
  async function reply(request: QuickAuthKey & { accountId: string }, selection: Selection | null, error?: string) {
    if (!localCurrent(request) || !await nativeCurrent(request) || !localCurrent(request)) return;
    const stage = selection?.stage ?? 'password';
    const accepted = await options.reply({ generation: request.generation, requestId: request.requestId, accountId: request.accountId,
      stage, ...(selection?.providers ? { providers: selection.providers } : {}), ...(error ? { error } : {}) });
    if (selection && accepted && stage === 'unlocked' && !error) selection.accepted = true;
  }
  // Authentication publishes unlocked before its background sync completes.
  // Let quick search follow that same state, including the sync-loading state.
  const stopChanges = options.subscribeVaultChanges?.(() => {
    const selection = selected; const key = current;
    if (!selection || !key || selection.stage === 'unlocked' || !selection.authentication?.isCurrent()
      || !selection.vault.isUnlocked() || !localCurrent(key, selection)) return;
    selection.stage = 'unlocked'; delete selection.providers;
    void (async () => {
      await assertCurrent(key, selection);
      await options.refresh();
      await assertCurrent(key, selection);
      await reply({ ...key, accountId: selection.accountId }, selection);
    })().catch(() => {});
  });
  return {
    async request(request: QuickAuthRequest) {
      const discard = () => { delete request.password; delete request.code; };
      // A delayed take must not replace an already-processing newer request.
      if (disposed || (current && (request.generation < current.generation
        || (request.generation === current.generation && request.requestId <= current.requestId)))) { discard(); return; }
      try { if (!await nativeCurrent(request)) { discard(); return; } }
      catch { discard(); return; }
      if (disposed || (current && (request.generation < current.generation
        || (request.generation === current.generation && request.requestId <= current.requestId)))) { discard(); return; }
      current = { generation: request.generation, requestId: request.requestId };
      let selection: Selection | null = selected;
      try {
        const selectAccount = request.action === 'select' || (request.action === 'password'
          && (!selection || selection.generation !== request.generation || selection.accountId !== request.accountId
            || !matches(selection.vault, request.accountId)));
        if (selectAccount) {
          invalidate();
          selection = { generation: request.generation, accountId: request.accountId, vault: options.getActiveVault(),
            version, selecting: false, switched: false, stage: 'password' };
          selected = selection;
        } else if (!selection || selection.generation !== request.generation || selection.accountId !== request.accountId) {
          throw new Error('请重新选择账户');
        }
        const available = await options.loadAccounts();
        await assertCurrent(request, selection ?? undefined);
        const account = available.find(value => value.id === request.accountId);
        if (!account) { invalidate(); throw new Error('账户已移除，请重新选择'); }
        if (!selection) throw new Error('请重新选择账户');
        if (selectAccount) {
          selection.selecting = true;
          try {
            await options.openAccount({ serverUrl: account.serverUrl, email: account.email }, () => assertCurrent(request, selection!));
          } finally { selection.selecting = false; }
          await assertCurrent(request, selection);
          if (!matches(selection.vault, request.accountId)) throw new Error('账户已切换，请重新选择');
          selection.stage = selection.vault.isUnlocked() ? 'unlocked' : 'password';
          if (request.action === 'select') { await reply(request, selection); return; }
        }
        const vault = selection.vault;
        if (!matches(vault, request.accountId)) throw new Error('账户已切换，请重新选择');
        if (vault.isUnlocked()) {
          selection.stage = 'unlocked';
          await reply(request, selection); return;
        }
        await assertCurrent(request, selection);
        if (request.action === 'twoFactor' && (selection.stage !== 'twoFactor' || !selection.authentication?.isCurrent())) {
          selection.stage = 'password'; delete selection.providers;
          throw new Error('两步验证已过期，请重新输入主密码');
        }
        if (selection.pendingRequest !== undefined) {
          selection.authentication?.cancel();
          selection.stage = 'password'; delete selection.providers;
          throw new Error('认证请求已变更，请重新输入主密码');
        }
        // Starting an operation is synchronous up to VaultClient's generation
        // increment. Capture it immediately, before any await or session switch.
        selection.pendingRequest = request.requestId;
        const operation = request.action === 'password'
          ? vault.unlock(request.password ?? '')
          : vault.connectWithTwoFactor(request.code ?? '', request.provider ?? 0, request.remember ?? false);
        delete request.password; delete request.code;
        selection.accepted = false;
        selection.authentication = vault.captureAuthentication();
        await operation;
        await assertCurrent(request, selection);
        if (!selection.authentication.isCurrent()) throw new Error('认证已变更，请重新选择账户');
        selection.stage = 'unlocked'; delete selection.providers;
        await options.refresh();
        await assertCurrent(request, selection);
        await reply(request, selection);
      } catch (error) {
        if (!localCurrent(request)) return;
        if (selection && selected === selection) {
          const challenge = twoFactorChallenge(error);
          if (challenge && selection.authentication?.isCurrent()) {
            selection.stage = 'twoFactor'; selection.providers = challenge.providers;
            await reply(request, selection); return;
          }
          if (selection.authentication && !selection.authentication.isCurrent()) {
            selection.stage = 'password'; delete selection.providers;
          }
        }
        const message = (value: unknown) => value instanceof Error ? value.message : '解锁失败，请重试';
        await reply(request, selected === selection ? selection : null,
          request.action === 'twoFactor' ? twoFactorErrorMessage(error, message) : message(error));
      } finally {
        if (selection?.pendingRequest === request.requestId) delete selection.pendingRequest;
        delete request.password; delete request.code;
      }
    },
    cancel(key: QuickAuthCancellation) {
      if (current && current.generation === key.generation && current.requestId <= key.requestId) {
        // Back from OTP keeps its identity but discards the cryptographic
        // challenge. The next password can retry without a second account click.
        selected?.authentication?.cancel(!(key.unlocked ?? selected.accepted));
        if (selected) {
          delete selected.authentication; delete selected.providers; delete selected.pendingRequest;
          selected.stage = selected.vault.isUnlocked() ? 'unlocked' : 'password';
        }
        void options.refresh().catch(() => {});
      }
    },
    dispose() { disposed = true; invalidate(); stop(); stopChanges?.(); },
  };
}
