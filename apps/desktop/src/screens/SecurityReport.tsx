import { useLocalStore, useStoreField, useStoreSnapshot } from '@1warden/state/react';
import { useEffect, useRef, type ReactNode } from 'react';
import {
  IconSpinner, PageHeader, SecurityReportView as SecurityReportBody,
  type BreachState, type ReportBrief,
} from '@1warden/ui';
import type { ApplicationClient, ApplicationSnapshot } from '../application/types';

const accountOf = (snapshot: ApplicationSnapshot) => JSON.stringify([
  snapshot.account?.serverUrl, snapshot.account?.email, snapshot.account?.userId, snapshot.status,
]);
const sourceOf = (snapshot: ApplicationSnapshot) => JSON.stringify([accountOf(snapshot), snapshot.revision]);

/** The service analyzes the vault; the shared screen receives display findings only. */
export function SecurityReportView({ client, onBack, renderItem }: {
  client: ApplicationClient;
  onBack?: () => void;
  renderItem?: (id: string, onBack: () => void) => ReactNode;
}) {
  const snapshot = useStoreSnapshot(client.subscribe, client.getSnapshot);
  const account = accountOf(snapshot);
  const source = sourceOf(snapshot);
  const viewStore = useLocalStore(() => ({ owner: client, account,
    report: null as ReportBrief | null, error: null as string | null,
    breachState: 'off' as BreachState, retry: 0, selectedId: null as string | null,
  }));
  const [owner] = useStoreField(viewStore, 'owner');
  const [reportAccount] = useStoreField(viewStore, 'account');
  const [storedReport] = useStoreField(viewStore, 'report');
  const [error] = useStoreField(viewStore, 'error');
  const [breachState] = useStoreField(viewStore, 'breachState');
  const [retry, setRetry] = useStoreField(viewStore, 'retry');
  const [selectedId, setSelectedId] = useStoreField(viewStore, 'selectedId');
  const request = useRef(0);
  const consent = useRef({ owner: client, account, enabled: false });
  const detail = useRef<HTMLDivElement>(null);
  const reportRegion = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const currentAccount = owner === client && reportAccount === account && snapshot.status === 'unlocked';
  const report = currentAccount ? storedReport : null;
  const selected = currentAccount ? selectedId : null;

  useEffect(() => {
    if (selected) detail.current?.focus({ preventScroll: true });
    else if (opener.current) {
      (opener.current.isConnected ? opener.current : reportRegion.current)?.focus({ preventScroll: true });
    }
  }, [selected]);

  useEffect(() => {
    const current = ++request.current;
    const changed = consent.current.owner !== client || consent.current.account !== account;
    if (changed) consent.current = { owner: client, account, enabled: false };
    viewStore.setState({ owner: client, account, error: null,
      ...(changed ? { report: null, breachState: 'off', selectedId: null } : {}),
    });
    if (snapshot.status !== 'unlocked') return;
    const valid = () => current === request.current && sourceOf(client.getSnapshot()) === source;
    void (async () => {
      try {
        const local = await client.securityReport(Date.now());
        if (!valid()) return;
        if (!consent.current.enabled) { viewStore.setState({ report: local }); return; }
        viewStore.setState({ breachState: 'checking' });
        try {
          const full = await client.checkBreaches(Date.now());
          if (valid()) viewStore.setState({ report: full, breachState: 'on' });
        } catch {
          if (valid()) viewStore.setState({ report: local, breachState: 'failed' });
        }
      } catch (cause) {
        if (valid()) viewStore.setState({ error: cause instanceof Error ? cause.message : '无法生成安全报告' });
      }
    })();
    return () => { request.current++; };
  }, [client, account, source, retry, viewStore]);

  async function enableBreachCheck(): Promise<void> {
    if (viewStore.getState().breachState === 'checking') return;
    consent.current = { owner: client, account, enabled: true };
    const current = ++request.current;
    viewStore.setState({ breachState: 'checking' });
    try {
      const full = await client.checkBreaches(Date.now());
      if (current === request.current && sourceOf(client.getSnapshot()) === source) {
        viewStore.setState({ report: full, breachState: 'on' });
      }
    } catch {
      if (current === request.current && sourceOf(client.getSnapshot()) === source) viewStore.setState({ breachState: 'failed' });
    }
  }

  function nameOf(id: string): string {
    const item = snapshot.items.find((i) => i.id === id);
    return item ? item.nameFailed ? '无法解密' : item.name : '（已不存在）';
  }

  return <main aria-label={selected ? '条目详情' : '安全报告'} className="flex min-h-0 flex-1 flex-col">
    {/* Keep the scroll container and disclosure state mounted through detail/edit/back. */}
    <div ref={reportRegion} tabIndex={-1} hidden={selected !== null} className={selected ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
      <PageHeader headingLevel={1} navigation title="安全报告" onBack={onBack} backLabel="返回保险库"
        breadcrumbs={[{ label: '保险库', ...(onBack ? { onSelect: onBack } : {}) }, { label: '安全报告' }]} />
      {currentAccount && error ? <div role="alert" className="p-8 text-sm text-[var(--risk)]">
        <p>{error}</p><button className="btn btn-quiet mt-3" onClick={() => setRetry((n) => n + 1)}>重试</button>
      </div> : report ? <SecurityReportBody report={report} nameOf={nameOf}
        {...(renderItem ? { onOpenItem: (id: string) => {
          opener.current = document.activeElement as HTMLElement | null;
          setSelectedId(id);
        } } : {})}
        breach={{ state: breachState, onEnable: () => { void enableBreachCheck(); } }}
      /> : <p role="status" className="flex items-center gap-2 p-8 text-sm text-[var(--ink-secondary)]"><IconSpinner size={15} />正在检查…</p>}
    </div>
    {selected && renderItem && <div ref={detail} tabIndex={-1} data-selectable className="min-h-0 flex-1 overflow-y-auto">
      <h1 className="sr-only">条目详情</h1>
      {renderItem(selected, () => setSelectedId(null))}
    </div>}
  </main>;
}
