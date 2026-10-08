import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect, useRef } from 'react';
import {
  IconSpinner, PageHeader, SecurityReportView as SecurityReportBody,
  type BreachState, type ReportBrief,
} from '@1warden/ui';
import type { ApplicationClient } from '../application/types';

/** The service analyzes the vault; the shared screen receives display findings only. */
export function SecurityReportView({ client, onBack }: { client: ApplicationClient; onBack?: () => void }) {
  const snapshot = client.getSnapshot();
  const viewStore = useLocalStore(() => {
    const report = (null) as ReportBrief | null;
    const error = (null) as string | null;
    const breachState = ('off') as BreachState;
    const now = Date.now();
    const retry = 0;
    return { report, error, breachState, now, retry };
  });
  const [report, setReport] = useStoreField(viewStore, 'report');
  const [error, setError] = useStoreField(viewStore, 'error');
  const [breachState, setBreachState] = useStoreField(viewStore, 'breachState');
  const [now] = useStoreField(viewStore, 'now');
  const [retry, setRetry] = useStoreField(viewStore, 'retry');
  const request = useRef(0);

  useEffect(() => {
    const current = ++request.current;
    setReport(null);
    setError(null);
    setBreachState('off');
    void client.securityReport(now).then((value) => {
      if (current === request.current) setReport(value);
    }).catch((e: unknown) => {
      if (current === request.current) setError(e instanceof Error ? e.message : '无法生成安全报告');
    });
    return () => { request.current++; };
  }, [client, snapshot.revision, now, retry]);

  async function enableBreachCheck(): Promise<void> {
    const current = request.current;
    setBreachState('checking');
    try {
      const breached = await client.checkBreaches();
      if (current !== request.current) return;
      setReport((value) => value ? { ...value, breached } : value);
      setBreachState('on');
    } catch {
      if (current === request.current) setBreachState('failed');
    }
  }

  function nameOf(id: string): string {
    const item = snapshot.items.find((i) => i.id === id);
    return item ? item.nameFailed ? '无法解密' : item.name : '（已不存在）';
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader navigation title="安全报告" onBack={onBack} backLabel="返回保险库"
        breadcrumbs={[{ label: '保险库', ...(onBack ? { onSelect: onBack } : {}) }, { label: '安全报告' }]} />
      {error ? <div role="alert" className="p-8 text-sm text-[var(--risk)]">
        <p>{error}</p><button className="btn btn-quiet mt-3" onClick={() => setRetry((n) => n + 1)}>重试</button>
      </div> : report ? <SecurityReportBody
        report={report}
        nameOf={nameOf}
        breach={{ state: breachState, onEnable: () => { void enableBreachCheck(); } }}
      /> : <p role="status" className="flex items-center gap-2 p-8 text-sm text-[var(--ink-secondary)]"><IconSpinner size={15} />正在检查…</p>}
    </div>
  );
}
