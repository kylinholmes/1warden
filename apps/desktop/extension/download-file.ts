/** Keep the Blob alive until the browser reports a terminal download state. */
export async function downloadFile(downloads: typeof chrome.downloads, fileName: string, dataBase64: string): Promise<{ path: string | null }> {
  const bytes = Uint8Array.from(atob(dataBase64), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes]));
  bytes.fill(0);
  let id: number | undefined;
  type Terminal = { state: string; error?: string | undefined };
  const early = new Map<number, Terminal>();
  let finish!: (result: Terminal) => void;
  const finished = new Promise<Terminal>(resolve => { finish = resolve; });
  const onChanged = (change: chrome.downloads.DownloadDelta) => {
    const state = change.state?.current;
    if (state !== 'complete' && state !== 'interrupted') return;
    const result = { state, error: change.error?.current };
    if (change.id === id) finish(result);
    else if (id === undefined) early.set(change.id, result);
  };
  downloads.onChanged.addListener(onChanged);
  try {
    try { id = await downloads.download({ url, filename: fileName.replace(/[\\/]/g, '_'), saveAs: true }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/USER_CANCELED|USER_CANCELLED|cancel(?:l)?ed by (?:the )?user|user cancel(?:l)?ed/i.test(message)) return { path: null };
      throw error;
    }
    const terminal = early.get(id); early.clear();
    if (terminal) finish(terminal);
    else {
      // A tiny download can finish between starting and receiving its change event.
      const [current] = await downloads.search({ id });
      if (current?.state === 'complete' || current?.state === 'interrupted') finish({ state: current.state, error: current.error });
    }
    const result = await finished;
    if (result.state === 'complete') return { path: fileName };
    if (result.error === 'USER_CANCELED') return { path: null };
    throw new Error(`文件保存失败：${result.error ?? '下载中断'}，请重试`);
  } finally {
    downloads.onChanged.removeListener(onChanged);
    URL.revokeObjectURL(url);
  }
}
