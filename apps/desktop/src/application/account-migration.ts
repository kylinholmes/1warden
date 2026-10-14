import { createVaultExport, parseBitwardenJson, type VaultClient } from '@1warden/vault';
import type { ImportOutcome, ImportPreview } from '@1warden/ui';
import { accountKey } from './account-target';

/** Secret data stays with the account owner; only counts and warnings leave preview. */
export function createAccountMigration(source: VaultClient, target: VaultClient, assertOwner: () => void | Promise<void>) {
  const sourceSession = source.getSession(); const targetSession = target.getSession();
  const sourceKey = sourceSession.getKey(); const targetKey = targetSession.getKey();
  const sourceAccount = sourceSession.account; const targetAccount = targetSession.account;
  if (!sourceKey || !targetKey || !sourceAccount || !targetAccount) throw new Error('请先解锁来源和当前账户');
  if (accountKey(sourceAccount) === accountKey(targetAccount)) throw new Error('不能将当前账户导入到相同账户');
  const assertSessions = () => {
    if (!source.isUnlocked() || !target.isUnlocked() || sourceSession.getKey() !== sourceKey || targetSession.getKey() !== targetKey
      || sourceSession.account !== sourceAccount || targetSession.account !== targetAccount) {
      throw new Error('迁移已取消，来源或当前账户已锁定或变更');
    }
  };
  const assertCurrent = async () => { assertSessions(); await assertOwner(); assertSessions(); };
  const read = async () => {
    await assertCurrent();
    const data = await source.readExportData();
    await assertCurrent();
    const exported = await createVaultExport({ items: data.items, folders: data.folders, format: 'json' });
    try {
      await assertCurrent();
      const parsed = parseBitwardenJson(new TextDecoder().decode(exported.bytes));
      const warnings = [
        '导入时会重新读取来源账户的最新数据，数量可能与预览不同；来源账户保持不变。',
        '仅复制个人保险库及归档记录；不复制回收站、组织条目、个人资料、附件文件和当前版本未支持的未知字段。',
        '记录的创建和修改时间由目标服务器重新生成；密码历史及密码修改时间会保留。',
        ...exported.warnings,
      ];
      if (data.organizationItems) warnings.push(`已排除 ${data.organizationItems} 条组织条目。`);
      return { parsed, warnings };
    } finally { exported.bytes.fill(0); }
  };
  return {
    async preview(): Promise<ImportPreview> {
      const { parsed, warnings } = await read();
      await assertCurrent();
      return { fileName: sourceAccount.email, format: 'bitwarden-json', formatLabel: '账户迁移',
        total: parsed.items.length, byType: parsed.items.reduce<Record<string, number>>((counts, item) => {
          counts[item.type] = (counts[item.type] ?? 0) + 1; return counts;
        }, {}), folders: new Set(parsed.folderNames).size, skipped: parsed.skipped, warnings };
    },
    async import(options: { skipExisting: boolean }): Promise<ImportOutcome> {
      const { parsed } = await read();
      // Internal conversion should be complete. Never turn an unreadable source into apparent success.
      if (parsed.skipped.length) throw new Error('部分来源记录无法完整转换，请修复后重新预览');
      await assertCurrent();
      const result = await target.importItems(parsed.items, undefined, parsed.folderNames, { ...options, assertCurrent });
      await assertCurrent();
      // Reconcile accepted writes even when their responses were lost, retaining the known outcome if sync fails.
      await target.refresh().catch(() => {});
      await assertCurrent();
      return result;
    },
  };
}
