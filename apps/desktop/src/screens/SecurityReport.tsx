import { useEffect, useRef, useState } from 'react';
import {
  IconSpinner, NavTrigger, SecurityReportView as SecurityReportBody,
  type BreachState, type ReportBrief,
} from '@coffer/ui';
import type { ApplicationClient } from '../application/types';

/** The service analyzes the vault; the shared screen receives display findings only. */
export function SecurityReportView({ client }: { client: ApplicationClient }) {
  const snapshot = client.getSnapshot();
  const [report, setReport] = useState<ReportBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [breachState, setBreachState] = useState<BreachState>('off');
  const [now] = useState(() => Date.now());
  const [retry, setRetry] = useState(0);
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
      <header className="band shrink-0 px-8" data-tauri-drag-region="deep">
        <NavTrigger />
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">安全报告</h2>
      </header>
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
