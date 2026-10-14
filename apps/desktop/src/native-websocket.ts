import { Channel, invoke } from '@tauri-apps/api/core';

type SocketEvent = { type: 'open' } | { type: 'close' } | { type: 'error' }
  | { type: 'text'; data: string } | { type: 'binary'; data: number[] };

/** SignalR's WebSocket transport, backed by the same pinned TLS verifier as native HTTP. */
class NativeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private readonly id = crypto.randomUUID();
  private readonly registered: Promise<void>;
  private writes: Promise<void> = Promise.resolve();

  constructor(url: string) {
    const events = new Channel<SocketEvent>();
    events.onmessage = event => {
      if (event.type === 'close' || event.type === 'error') {
        if (event.type === 'error' && this.readyState < 2) this.onerror?.(new Event('error'));
        this.closed(event.type === 'close');
      } else if (event.type === 'open') {
        if (this.readyState !== 0) return;
        this.readyState = 1; this.onopen?.(new Event('open'));
      } else if (this.readyState === 1) {
        this.onmessage?.({ data: event.type === 'text' ? event.data : new Uint8Array(event.data).buffer } as MessageEvent);
      }
    };
    this.registered = invoke<void>('websocket_open', { id: this.id, url, events });
    void this.registered.catch(() => {
      if (this.readyState < 2) this.onerror?.(new Event('error'));
      this.closed(false);
    });
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) throw new Error('推送连接尚未就绪');
    const payload = typeof data === 'string' ? { text: data } : { bytes: Array.from(new Uint8Array(data)) };
    this.writes = this.writes.then(() => this.registered)
      .then(() => invoke<void>('websocket_send', { id: this.id, ...payload }))
      .catch(() => { this.close(); });
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    void this.registered.then(() => invoke('websocket_close', { id: this.id }))
      .catch(() => {}).finally(() => this.closed(true));
  }

  private closed(clean: boolean): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: clean ? 1000 : 1006, reason: '', wasClean: clean } as CloseEvent);
  }
}

// SignalR uses constructor, binaryType, readyState, four event callbacks, send and close.
export const NativeWebSocket = NativeSocket as unknown as typeof WebSocket;
