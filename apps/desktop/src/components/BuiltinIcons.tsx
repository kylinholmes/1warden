import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useId } from 'react';
import { BUILTIN_CARD_ICONS, BUILTIN_SERVICE_ICONS, ItemIcon, Segmented } from '@1warden/ui';
import { openWebsite } from '../open-website';

type Category = 'all' | 'services' | 'cards';
const SOURCE_ADYEN = {
  name: 'Adyen',
  url: 'https://help.adyen.com/knowledge/payment-methods/manage-payment-methods/where-can-i-find-payment-method-logos-for-my-checkout-or-website',
};
const ENTRIES = [
  ...BUILTIN_SERVICE_ICONS.map(icon => ({
    key: `service:${icon.id}`, category: 'services' as const, name: icon.name,
    domains: icon.domains as readonly string[], keywords: icon.keywords as readonly string[], cardBrand: null, source: icon.source,
  })),
  ...BUILTIN_CARD_ICONS.map(icon => ({
    key: `card:${icon.id}`, category: 'cards' as const, name: icon.name,
    domains: [] as readonly string[], keywords: [] as readonly string[], cardBrand: icon.id, source: SOURCE_ADYEN,
  })),
];

export const BUILTIN_ICON_COUNTS = {
  services: BUILTIN_SERVICE_ICONS.length, cards: BUILTIN_CARD_ICONS.length, total: ENTRIES.length,
};

/** A read-only view of the real bundled registry, not a separate demo collection. */
export function BuiltinIcons() {
  const store = useLocalStore(() => ({ query: '', category: 'all' as Category, openError: false }));
  const [query, setQuery] = useStoreField(store, 'query');
  const [category, setCategory] = useStoreField(store, 'category');
  const [openError, setOpenError] = useStoreField(store, 'openError');
  const searchId = useId();
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const entries = ENTRIES.filter(entry => {
    if (category !== 'all' && entry.category !== category) return false;
    const text = [entry.name, ...entry.domains, ...entry.keywords, entry.source.name].join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });

  return <section className="space-y-4" aria-label="内建图标目录">
    <div>
      <h3 className="text-md font-medium">内建图标</h3>
      <p className="mt-1 text-xs leading-relaxed text-[var(--ink-tertiary)]">
        {BUILTIN_ICON_COUNTS.services} 种网站与服务 · {BUILTIN_ICON_COUNTS.cards} 种卡组织。本地内置，离线可用。
      </p>
      <p className="mt-1 text-xs leading-relaxed text-[var(--ink-tertiary)]">
        网站按域名自动匹配，未收录时尝试站点图标，再使用文本或类型图标。这里用于浏览，不会更改条目。
      </p>
    </div>
    <div className="space-y-3">
      <label htmlFor={searchId} className="sr-only">搜索内建图标</label>
      <input id={searchId} type="search" className="field w-full" placeholder="搜索名称、域名、中国网站或 Web3…"
        value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
      <Segmented<Category> value={category} label="图标类别" onChange={setCategory} className="max-w-full flex-wrap"
        options={[
          { value: 'all', label: `全部 ${BUILTIN_ICON_COUNTS.total}` },
          { value: 'services', label: `网站 ${BUILTIN_ICON_COUNTS.services}` },
          { value: 'cards', label: `卡组织 ${BUILTIN_ICON_COUNTS.cards}` },
        ]} />
    </div>
    <p className="text-xs text-[var(--ink-tertiary)]" role="status" aria-live="polite">显示 {entries.length} 个图标</p>
    {openError && <p role="alert" className="text-xs text-[var(--risk)]">无法打开来源页面，请稍后重试。</p>}
    {entries.length > 0 ? <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-3" aria-label="内建图标列表">
      {entries.map(entry => <li key={entry.key} className="card min-w-0 p-3">
        <div className="flex min-w-0 items-center gap-3">
          <ItemIcon type={entry.category === 'cards' ? 'card' : 'login'} iconDomain={entry.domains[0] ?? null}
            cardBrand={entry.cardBrand} text="" hue={220} store={null} size={40} />
          <span className="min-w-0 break-words text-sm font-medium">{entry.name}</span>
        </div>
        <p className="mt-3 break-words text-xs leading-relaxed text-[var(--ink-secondary)]">
          {entry.domains.length > 0 ? entry.domains.join(' · ') : '按已保存的卡片品牌匹配'}
        </p>
        <a className="mt-2 inline-block text-xs text-[var(--accent)] underline underline-offset-2" href={entry.source.url}
          onClick={event => {
            event.preventDefault(); setOpenError(false);
            void openWebsite(entry.source.url).catch(() => setOpenError(true));
          }}
          target="_blank" rel="noreferrer noopener" aria-label={`${entry.name} 图标来源：${entry.source.name}（新窗口）`}>
          来源：{entry.source.name}
        </a>
      </li>)}
    </ul> : <div className="card p-6 text-center">
      <p className="text-sm">没有找到匹配的图标</p>
      <p className="mt-1 text-xs text-[var(--ink-tertiary)]">试试品牌名称或域名，未收录的网站仍可获取站点图标。</p>
      <button type="button" className="btn btn-ghost mt-3" onClick={() => { setQuery(''); setCategory('all'); }}>显示全部图标</button>
    </div>}
    <p className="text-xs leading-relaxed text-[var(--ink-tertiary)]">
      标识属于各自品牌，仅用于识别条目，不表示网站安全或官方合作。界面操作图标不计入此目录。
    </p>
  </section>;
}
