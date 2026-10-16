import { createStore } from '@1warden/state';
/** Updates are independent of vault sessions and carry only app version/download state. */
export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export interface AppUpdate {
  version: string;
  /** A release that must be installed through its original distribution channel. */
  manual?: string;
  /** Windows downloads first; invoking its installer can terminate this process. */
  installOnRestart?(): Promise<void>;
  downloadAndInstall(onEvent: (event: DownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
}
export interface UpdateBackend {
  currentVersion(): Promise<string>;
  check(): Promise<AppUpdate | null>;
  restart(): Promise<void>;
}
export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'ready' | 'restarting' | 'error';
  manual: string | null;
  installOnRestart: boolean;
  currentVersion: string | null;
  targetVersion: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  checkedAt: number | null;
  error: string | null;
}
export interface AppUpdater {
  getSnapshot(): Readonly<UpdateState>;
  subscribe(listener: () => void): () => void;
  start(): void;
  check(): Promise<void>;
  restart(): Promise<void>;
  dispose(): void;
}

const STARTUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** One owner per window; a prepared download stays ready until installation or disposal. */
export function createAppUpdater(backend: UpdateBackend, startupDelay = STARTUP_DELAY_MS): AppUpdater {
  const store = createStore<Readonly<UpdateState>>(() => ({ phase: 'idle', currentVersion: null, targetVersion: null,
    downloadedBytes: 0, totalBytes: null, checkedAt: null, error: null, manual: null, installOnRestart: false }));
  const subscriptions = new Set<() => void>();
  let started = false;
  let disposed = false;
  let generation = 0;
  let pending: Promise<void> | null = null;
  let pendingRestart: Promise<void> | null = null;
  let versionRequest: Promise<void> | null = null;
  let startup: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let prepared: AppUpdate | null = null;

  function publish(patch: Partial<UpdateState>) {
    if (disposed) return;
    store.setState(patch);
  }
  const current = (version: number) => !disposed && version === generation;
  function loadVersion(): Promise<void> {
    if (store.getState().currentVersion !== null) return Promise.resolve();
    versionRequest ??= backend.currentVersion().then((currentVersion) => {
      publish({ currentVersion });
    }).finally(() => { versionRequest = null; });
    return versionRequest;
  }

  async function run(version: number): Promise<void> {
    let release: AppUpdate | null = null;
    let downloading = false;
    try {
      if (!current(version)) return;
      publish({ phase: 'checking', error: null, downloadedBytes: 0, totalBytes: null });
      await loadVersion();
      if (!current(version)) return;
      release = await backend.check();
      if (!current(version)) return;
      publish({ checkedAt: Date.now() });
      if (!release) { publish({ phase: 'idle', targetVersion: null, manual: null, installOnRestart: false }); return; }
      publish({ targetVersion: release.version, manual: release.manual ?? null, installOnRestart: !!release.installOnRestart });
      if (release.manual) { publish({ phase: 'available' }); return; }
      downloading = true;
      publish({ phase: 'downloading', targetVersion: release.version });
      await release.downloadAndInstall((event) => {
        if (!current(version) || store.getState().phase !== 'downloading') return;
        if (event.event === 'Started') {
          const length = event.data.contentLength;
          publish({ totalBytes: typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : null,
            downloadedBytes: 0 });
        } else if (event.event === 'Progress') {
          const chunk = event.data.chunkLength;
          if (Number.isFinite(chunk) && chunk >= 0) publish({ downloadedBytes: store.getState().downloadedBytes + chunk });
        } else publish({ phase: 'installing' });
      });
      // Finished precedes signature verification. On macOS installation must also
      // complete; on Windows the verified bytes stay owned until explicit install.
      if (current(version)) {
        if (release.installOnRestart) { prepared = release; release = null; }
        publish({ phase: 'ready', error: null });
      }
    } catch {
      if (current(version)) publish({ phase: 'error', error: downloading
        ? '更新准备失败，请重试。' : '暂时无法检查更新，请稍后重试。' });
    } finally {
      try { await release?.close(); } catch { /* Resource cleanup cannot undo a successfully installed update. */ }
    }
  }

  function check(): Promise<void> {
    if (disposed || store.getState().phase === 'ready' || store.getState().phase === 'restarting') return Promise.resolve();
    if (pending) return pending;
    const version = ++generation;
    const request = Promise.resolve().then(() => run(version)).finally(() => {
      if (pending === request) pending = null;
    });
    pending = request;
    return request;
  }

  function restart(): Promise<void> {
    if (pendingRestart) return pendingRestart;
    if (disposed || store.getState().phase !== 'ready') return Promise.resolve();
    publish({ phase: 'restarting', error: null });
    const request = (prepared?.installOnRestart
      ? prepared.installOnRestart() : backend.restart()).catch(() => {
      publish({ phase: 'ready', error: prepared ? '无法安装更新，请重试或手动更新。' : '无法重启，请稍后再试。' });
    }).finally(() => { if (pendingRestart === request) pendingRestart = null; });
    pendingRestart = request;
    return request;
  }

  return {
    getSnapshot: store.getState,
    subscribe(listener) {
      const stop = store.subscribe(listener); subscriptions.add(stop);
      return () => { stop(); subscriptions.delete(stop); };
    },
    start() {
      if (started || disposed) return;
      started = true;
      void loadVersion().catch(() => {});
      startup = setTimeout(() => { void check(); }, startupDelay);
      interval = setInterval(() => { void check(); }, CHECK_INTERVAL_MS);
    },
    check,
    restart,
    dispose() {
      disposed = true; generation++;
      clearTimeout(startup); clearInterval(interval);
      if (prepared) { void prepared.close().catch(() => {}); prepared = null; }
      for (const stop of subscriptions) stop(); subscriptions.clear();
    },
  };
}
