import type { VaultFolder } from '@1warden/vault';
import type { ApplicationClient, ApplicationSnapshot } from './types';

type Assignment = { name: string; folder?: VaultFolder; promise?: Promise<VaultFolder> };
// A revision replaces the detail component after creation. Keep the operation and
// a failed assignment's folder outside that component so retry cannot recreate it.
const assignments = new WeakMap<ApplicationClient, Map<string, Assignment>>();

function identity(snapshot: ApplicationSnapshot): string {
  return JSON.stringify([snapshot.account?.serverUrl, snapshot.account?.email, snapshot.account?.userId]);
}

/** Lets the replacement detail preserve busy controls until the assignment settles. */
export function pendingFolderAssignment(client: ApplicationClient, itemId: string): Promise<VaultFolder> | undefined {
  return assignments.get(client)?.get(JSON.stringify([identity(client.getSnapshot()), itemId]))?.promise;
}

export async function createAndAssignFolder(client: ApplicationClient, itemId: string, name: string): Promise<VaultFolder> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('请输入文件夹名称');
  const started = client.getSnapshot();
  if (started.status !== 'unlocked' || !started.account) throw new Error('保险库未解锁');
  if (!started.items.some(item => item.id === itemId)) throw new Error('找不到这条记录');
  const account = identity(started);
  const target = JSON.stringify([account, itemId]);
  let pending = assignments.get(client);
  if (!pending) { pending = new Map(); assignments.set(client, pending); }
  const previous = pending.get(target);
  if (previous?.promise) {
    if (previous.name === trimmed) return previous.promise;
    throw new Error('文件夹归类正在保存，请稍候');
  }
  const assignment: Assignment = previous?.name === trimmed ? previous : { name: trimmed };
  pending.set(target, assignment);
  let current = true;
  const sameAccount = () => client.getSnapshot().status === 'unlocked' && identity(client.getSnapshot()) === account;
  const unsubscribe = client.subscribe(() => { if (!sameAccount()) current = false; });
  function assertCurrent() {
    if (!current || !sameAccount()) throw new Error('保险库已锁定或账户已变化，请重新打开条目');
  }
  const promise = (async () => {
    try {
      assertCurrent();
      if (!assignment.folder) assignment.folder = await client.createFolder(trimmed);
      assertCurrent();
      if (!client.getSnapshot().folders.some(folder => folder.id === assignment.folder!.id)) {
        throw new Error('文件夹暂不可用，请从已有文件夹重新选择');
      }
      await client.moveToFolder(itemId, assignment.folder.id);
      assertCurrent();
      pending.delete(target);
      return assignment.folder;
    } catch (cause) {
      if (!assignment.folder) { pending.delete(target); throw cause; }
      const reason = cause instanceof Error ? cause.message : '请稍后重试';
      throw new Error(`文件夹已创建，条目归类未完成：${reason}。请选择已有文件夹，或重试归类。`, { cause });
    } finally {
      unsubscribe();
    }
  })();
  assignment.promise = promise;
  const settled = () => { if (assignment.promise === promise) delete assignment.promise; };
  void promise.then(settled, settled);
  return promise;
}
