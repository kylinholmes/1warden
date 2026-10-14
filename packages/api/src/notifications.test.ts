import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';
import { MessageType } from '@microsoft/signalr';
import { subscribeNotifications } from './notifications';

class Socket {
  static sockets: Socket[] = [];
  static fail = false;
  static OPEN = 1;
  readyState = 1;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  handshake = '';
  constructor(readonly url: string) {
    Socket.sockets.push(this);
    queueMicrotask(() => Socket.fail ? this.onclose?.({ code: 1006 }) : this.onopen?.());
  }
  send(data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      this.handshake = data;
      queueMicrotask(() => this.onmessage?.({ data: new TextEncoder().encode('{}\x1e').buffer }));
    }
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, wasClean: true }); }
  push(type: number) {
    this.onmessage?.({ data: new MessagePackHubProtocol().writeMessage({ type: MessageType.Invocation,
      target: 'ReceiveMessage', arguments: [{ Type: type, Payload: {} }] }) });
  }
}
let stop: (() => void) | undefined;
afterEach(async () => { stop?.(); await Promise.resolve(); vi.useRealTimers(); Socket.sockets = []; Socket.fail = false; });
function start() {
  const sync = vi.fn(); const logout = vi.fn();
  stop = subscribeNotifications({ serverUrl: 'https://vault.test/subpath/', accessToken: async () => 'secret', onSync: sync, onLogout: logout }, Socket as unknown as typeof WebSocket);
  return { sync, logout };
}

describe('Vaultwarden SignalR notifications', () => {
  it('uses MessagePack, preserves server subpaths and syncs on vault change messages', async () => {
    vi.useFakeTimers();
    const f = start(); await vi.advanceTimersByTimeAsync(0);
    const socket = Socket.sockets[0]!;
    expect(socket.url).toContain('wss://vault.test/subpath/notifications/hub');
    expect(socket.handshake).toBe('{"protocol":"messagepack","version":1}\x1e');
    expect(f.sync).toHaveBeenCalledOnce();
    for (const type of [0, 1, 2, 3, 4, 5, 7, 8, 10]) socket.push(type);
    expect(f.sync).toHaveBeenCalledTimes(10);
    socket.push(100); socket.push(15);
    expect(f.sync).toHaveBeenCalledTimes(10);
    socket.push(11); expect(f.logout).toHaveBeenCalledOnce();
  });

  it('retries an initial connection failure and syncs after reconnecting', async () => {
    vi.useFakeTimers(); Socket.fail = true;
    const f = start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.sync).not.toHaveBeenCalled();
    Socket.fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.sync).toHaveBeenCalledOnce();
    Socket.sockets.at(-1)!.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.sync).toHaveBeenCalledTimes(2);
  });

  it('cancels reconnect timers and late messages on disposal', async () => {
    vi.useFakeTimers();
    const f = start(); await vi.advanceTimersByTimeAsync(0);
    Socket.sockets[0]!.close(); stop!();
    Socket.sockets[0]!.push(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Socket.sockets).toHaveLength(1);
    expect(f.sync).toHaveBeenCalledOnce();
  });
});
