import { sortItems, type SortBy } from '@coffer/vault';
import type { ItemSummary } from '@coffer/ui';

export type VaultCategory =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'site' }
  | { kind: 'folder'; id: string }
  | { kind: 'type'; type: string }
  | { kind: 'security' }
  | { kind: 'import' };

/** Apply navigation to the current search results, keeping the session array intact. */
export function visibleVaultItems(
  items: readonly ItemSummary[],
  category: VaultCategory,
  sortBy: SortBy,
  matchedIds: readonly string[] = [],
): ItemSummary[] {
  const matches = new Set(matchedIds);
  let pool = items;
  if (category.kind === 'favorites') pool = pool.filter((item) => item.favorite);
  else if (category.kind === 'folder') pool = pool.filter((item) => item.folderId === category.id);
  else if (category.kind === 'type') pool = pool.filter((item) => item.type === category.type);
  else if (category.kind === 'site') pool = pool.filter((item) => matches.has(item.id));
  const ordered = sortItems(pool, sortBy);
  if (matches.size === 0) return ordered;
  // Partition after sorting so each group retains the user's chosen order.
  return [
    ...ordered.filter((item) => matches.has(item.id)),
    ...ordered.filter((item) => !matches.has(item.id)),
  ];
}
