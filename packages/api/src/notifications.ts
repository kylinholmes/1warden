import { HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';

export interface NotificationsOptions {
  serverUrl: string;
  accessToken(): Promise<string>;
  onSync(): void | Promise<void>;
  onLogout(): void;
}
export type NotificationsFactory = (options: NotificationsOptions) => () => void;

/** One authenticated connection per unlocked vault. No credentials or payloads are logged. */
export function subscribeNotifications(options: NotificationsOptions, socket?: typeof WebSocket): () => void {
  const connection = new HubConnectionBuilder()
    .withUrl(`${options.serverUrl.replace(/\/+$/, '')}/notifications/hub`, {
      accessTokenFactory: options.accessToken,
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
      ...(socket ? { WebSocket: socket } : {}),
    })
    .withHubProtocol(new MessagePackHubProtocol())
    .configureLogging(LogLevel.None)
    .build();
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  connection.on('ReceiveMessage', (message: unknown) => {
    if (disposed || !message || typeof message !== 'object') return;
    const type = (message as { Type?: unknown; type?: unknown }).Type ?? (message as { type?: unknown }).type;
    if (type === 11) options.onLogout();
    else if (typeof type === 'number' && ((type >= 0 && type <= 10) || (type >= 17 && type <= 19))) options.onSync();
  });
  function reconnect() {
    if (disposed || retry !== undefined) return;
    retry = setTimeout(() => { retry = undefined; void start(); }, delay);
    delay = Math.min(delay * 2, 30_000);
  }
  async function start() {
    try {
      await connection.start();
      if (disposed) { await connection.stop(); return; }
      delay = 1000;
      // Covers changes between the initial sync and subscription, and while disconnected.
      options.onSync();
    } catch { reconnect(); }
  }
  connection.onclose(reconnect);
  void start();
  return () => {
    disposed = true;
    clearTimeout(retry);
    void connection.stop().catch(() => {});
  };
}
