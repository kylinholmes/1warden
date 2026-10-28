// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItemEditor } from '../../../../packages/ui/src/ItemEditor';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import type { VaultItem } from '@1warden/vault';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ApplicationSnapshot } from '../application/types';
import type { ProfileAutosave } from '../profile-autosave';
import type { AppUpdater, UpdateState } from '../updates/controller';
import { safeRestart } from '../updates/safe-restart';
import { ProfileAutosaveProvider, useProfileAutosave } from './ProfileAutosave';
import AppUpdateNotice from './AppUpdateNotice';
import AppUpdates from './AppUpdates';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await act(async () => { root?.unmount(); cleanups.splice(0).forEach(cleanup => cleanup()); });
  host?.remove();
});
const registerRestartCheck: NonNullable<ComponentProps<typeof ItemEditor>['registerRestartCheck']> = (prepare, finish) => safeRestart.register({ prepare, finish });
function button(label: string, index = 0) {
  const node = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent?.trim() === label)[index];
  if (!node) throw new Error(`Missing button ${label}`);
  return node;
}
const click = async (node: HTMLElement) => { await act(() => node.click()); };
async function editName(value = 'Synthetic edit') {
  const node = host.querySelector<HTMLInputElement>('[data-editor-name]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function setup(options: { editor?: boolean; saveItem?: (draft: VaultItem) => Promise<{ id: string; name: string }>;
  createFolder?: (name: string) => Promise<{ id: string; name: string }> } = {}) {
  let snapshot: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked', profileReady: true,
    account: { serverUrl: 'https://synthetic.test', email: 'test@synthetic.test', userId: '', kdf: { kdf: 0, iterations: 1 } },
    profile: { displayName: 'Before', avatarDataUrl: null }, profileVersion: '1' };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<ApplicationSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); };
  const saveProfile = vi.fn(async profile => { update({ profile, profileVersion: '2' }); });
  const client = { getSnapshot: () => snapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    saveProfile, savePreferences: vi.fn() } as unknown as ApplicationClient;
  let profile!: ProfileAutosave;
  function Capture() { profile = useProfileAutosave()!; return null; }
  const state: UpdateState = { phase: 'ready', currentVersion: '1', targetVersion: '2', downloadedBytes: 1, totalBytes: 1,
    installOnRestart: false, checkedAt: 1, error: null, manual: null };
  const restart = vi.fn(async () => {});
  const updater: AppUpdater = { getSnapshot: () => state, subscribe: () => () => {}, restart, check: vi.fn(), start() {}, dispose() {} };
  const saveItem = vi.fn(options.saveItem ?? (async (draft: VaultItem) => ({ id: 'synthetic-id', name: draft.name })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(<>
    {/* The notice intentionally lives outside the App's profile provider. */}
    <AppUpdateNotice updater={updater} />
    <ProfileAutosaveProvider client={client}><Capture /><AppUpdates updater={updater} />
      {options.editor !== false && <ItemEditor folders={[]} item={{ ...blankEditorItem(), name: 'Synthetic original' }} open
        onSave={saveItem} onDone={() => {}} onCancel={() => {}} registerRestartCheck={registerRestartCheck}
        {...(options.createFolder ? { onCreateFolder: options.createFolder } : {})} />}
    </ProfileAutosaveProvider>
  </>));
  return { updater, restart, saveItem, saveProfile, profile, update, state, listeners };
}

describe('safe update restart across both hosts', () => {
  it.each([0, 1])('blocks discard from host %s when a folder write starts in the same tick, until an explicit later decision', async index => {
    let release!: () => void;
    const createFolder = vi.fn(async (name: string) => {
      await new Promise<void>(resolve => { release = resolve; }); return { id: 'synthetic-folder', name };
    });
    const { restart } = await setup({ createFolder }); await editName(); await click(button('重启更新', index));
    const name = host.querySelector<HTMLInputElement>('[aria-label="新文件夹名称"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Synthetic folder');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const create = button('创建文件夹'); const discard = button('放弃改动并重启');
    await act(() => {
      create.click();
      // Keep both events in the same batch: the rendered disabled state has
      // not caught up with the synchronous creatingFolder snapshot yet.
      expect(discard.disabled).toBe(false);
      discard.click();
    });
    expect(createFolder).toHaveBeenCalledTimes(1); expect(restart).not.toHaveBeenCalled();
    expect(button('放弃改动并重启').disabled).toBe(true);
    expect(button('保存并重启').disabled).toBe(true);
    expect(button('继续编辑').disabled).toBe(false);
    await act(async () => { release(); });
    expect(restart).not.toHaveBeenCalled(); expect(button('放弃改动并重启').disabled).toBe(false);
    await click(button('放弃改动并重启')); expect(restart).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1])('asks for an explicit editor decision from host %s and cancel retains the draft', async index => {
    const { restart, saveItem } = await setup(); await editName();
    await click(button('重启更新', index));
    expect(restart).not.toHaveBeenCalled(); expect(saveItem).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('继续编辑'));
    await click(button('继续编辑'));
    expect(host.querySelector<HTMLInputElement>('[data-editor-name]')!.value).toBe('Synthetic edit');
    expect(safeRestart.getSnapshot().busy).toBe(false);
    await click(button('重启更新', index)); await click(button('放弃改动并重启'));
    expect(restart).toHaveBeenCalledTimes(1); expect(saveItem).not.toHaveBeenCalled();
  });
  it('saves the local draft and flushes profile once across duplicate restart calls', async () => {
    let release!: () => void;
    const { updater, restart, saveItem, saveProfile, profile } = await setup({ saveItem: async draft => {
      await new Promise<void>(resolve => { release = resolve; }); return { id: 'saved', name: draft.name };
    } });
    await editName(); await act(() => profile.editProfile({ displayName: 'Synthetic profile' }));
    await click(button('重启更新'));
    const first = safeRestart.restart(updater); const second = safeRestart.restart(updater);
    expect(first).toBe(second);
    await click(button('保存并重启'));
    expect(button('保存中…').disabled).toBe(true); expect(restart).not.toHaveBeenCalled();
    await act(async () => { release(); await first; });
    expect(saveItem).toHaveBeenCalledTimes(1); expect(saveProfile).toHaveBeenCalledTimes(1); expect(restart).toHaveBeenCalledTimes(1);
  });
  it('retains failed editor saves and blocks restart', async () => {
    const { restart } = await setup({ saveItem: async () => { throw new Error('Synthetic offline'); } });
    await editName(); await click(button('重启更新')); await click(button('保存并重启'));
    expect(host.textContent).toContain('Synthetic offline'); expect(restart).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('[data-editor-name]')!.value).toBe('Synthetic edit');
    expect(button('保存').disabled).toBe(false);
  });
  it('returns focused save-and-restart failures to the surviving local Save control and can retry', async () => {
    let reject!: (cause: Error) => void;
    let attempts = 0;
    const { restart, saveItem } = await setup({ saveItem: async draft => {
      if (++attempts === 1) await new Promise<void>((_resolve, fail) => { reject = fail; });
      return { id: 'synthetic-retry', name: draft.name };
    } });
    await editName(); await click(button('重启更新'));
    const initiating = button('保存并重启'); initiating.focus();
    await click(initiating);
    await act(async () => { reject(new Error('Synthetic deferred save failure')); });
    const retry = button('保存');
    expect(initiating.isConnected).toBe(false);
    expect(retry.disabled).toBe(false);
    expect(document.activeElement).toBe(retry);
    expect(retry.closest('[role="dialog"]')).not.toBeNull();
    expect(restart).not.toHaveBeenCalled();
    await click(retry);
    expect(saveItem).toHaveBeenCalledTimes(2);
    expect(saveItem.mock.calls[1]![0].name).toBe('Synthetic edit');
    expect(restart).not.toHaveBeenCalled();
  });
  it('releases the editor after failed backend restart and retains the committed saved identity', async () => {
    const { restart, saveItem } = await setup(); restart.mockRejectedValueOnce(new Error('Synthetic installer failure'));
    await editName(); await click(button('重启更新')); await click(button('保存并重启'));
    expect(host.textContent).toContain('Synthetic installer failure'); expect(button('保存').disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>('[data-editor-name]')!.value).toBe('Synthetic edit');
    await click(button('重启更新'));
    expect(restart).toHaveBeenCalledTimes(2); expect(saveItem).toHaveBeenCalledTimes(1);
    await click(button('保存'));
    expect(saveItem.mock.calls.at(-1)![0].id).toBe('synthetic-id');
  });
  it('Escape cancels the restart question without abandoning the editor', async () => {
    const { restart } = await setup(); await editName(); await click(button('重启更新'));
    await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(restart).not.toHaveBeenCalled(); expect(safeRestart.getSnapshot().busy).toBe(false);
    expect(host.querySelector<HTMLInputElement>('[data-editor-name]')!.value).toBe('Synthetic edit');
    expect(button('保存').disabled).toBe(false);
  });
  it('account invalidation during a slow editor save cannot trigger a latent restart or unlock the in-flight save', async () => {
    let release!: () => void;
    const { restart, update } = await setup({ saveItem: async draft => {
      await new Promise<void>(resolve => { release = resolve; }); return { id: 'saved', name: draft.name };
    } });
    await editName(); await click(button('重启更新')); await click(button('保存并重启'));
    await act(() => update({ status: 'locked' }));
    expect(button('保存中…').disabled).toBe(true); expect(restart).not.toHaveBeenCalled();
    await act(async () => { release(); }); expect(restart).not.toHaveBeenCalled(); expect(button('保存').disabled).toBe(false);
  });
  it('blocks on failed profile flush and exposes recovery without losing a prepared update', async () => {
    const { restart, profile, saveProfile, state } = await setup({ editor: false });
    saveProfile.mockRejectedValueOnce(new Error('Synthetic profile failure'));
    await act(() => profile.editProfile({ displayName: 'Keep this profile' }));
    await click(button('重启更新'));
    expect(restart).not.toHaveBeenCalled(); expect(host.textContent).toContain('暂未重启'); expect(state.phase).toBe('ready');
    expect(profile.getSnapshot().profile.value.displayName).toBe('Keep this profile');
    await act(async () => { await profile.retry('profile'); });
    await click(button('重启更新', 1)); expect(restart).toHaveBeenCalledTimes(1);
  });
  it('flushes a dirty profile with no editor and preserves no-update behavior', async () => {
    const { profile, restart, saveProfile, state, updater } = await setup({ editor: false });
    await act(() => profile.editProfile({ displayName: 'Flush before restart' }));
    await click(button('重启更新', 1)); expect(saveProfile).toHaveBeenCalledTimes(1); expect(restart).toHaveBeenCalledTimes(1);
    state.phase = 'idle'; await safeRestart.restart(updater); expect(restart).toHaveBeenCalledTimes(1);
  });
  it('aborts the editor question on account changes and unregisters on unmount', async () => {
    const { restart, updater, update, listeners } = await setup(); await editName(); await click(button('重启更新'));
    await act(() => update({ status: 'locked' }));
    expect(safeRestart.getSnapshot().busy).toBe(false); expect(restart).not.toHaveBeenCalled();
    await click(button('重启更新')); expect(safeRestart.getSnapshot().busy).toBe(true);
    await act(() => root.unmount()); expect(listeners.size).toBe(0); expect(safeRestart.getSnapshot().busy).toBe(false);
    await act(async () => { await safeRestart.restart(updater); }); expect(restart).toHaveBeenCalledTimes(1);
  });
  it('rechecks transfer guards after an editor decision instead of bypassing a newly busy transfer', async () => {
    const { restart } = await setup(); let busy = false;
    const validate = () => { if (busy) throw new Error('Synthetic transfer in progress'); };
    cleanups.push(safeRestart.register({ priority: -10, prepare: () => { validate(); return true; }, validate }));
    await editName(); await click(button('重启更新')); busy = true; await click(button('放弃改动并重启'));
    expect(restart).not.toHaveBeenCalled(); expect(host.textContent).toContain('Synthetic transfer in progress');
    expect(button('保存').disabled).toBe(false);
  });
  it('blocks an already busy transfer before opening the editor question', async () => {
    const { restart } = await setup(); await editName();
    cleanups.push(safeRestart.register({ priority: -10, prepare: () => { throw new Error('Synthetic transfer busy'); } }));
    await click(button('重启更新'));
    expect(restart).not.toHaveBeenCalled(); expect(host.textContent).toContain('Synthetic transfer busy');
    expect(button('保存').disabled).toBe(false);
  });
});
