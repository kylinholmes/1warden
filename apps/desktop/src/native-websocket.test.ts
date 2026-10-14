import { afterEach, expect, it, vi } from 'vitest';
const ipc = vi.hoisted(() => ({ invoke: vi.fn(), events: null as null | ((event: unknown) => void) }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: ipc.invoke,
  Channel: class { set onmessage(callback: (event: unknown) => void) { ipc.events = callback; } },
}));
import { NativeWebSocket } from './native-websocket';
afterEach(() => { vi.resetAllMocks(); ipc.events = null; });

it('passes binary SignalR frames through native IPC without changing bytes', async () => {
  ipc.invoke.mockResolvedValue(undefined);
  const ws = new NativeWebSocket('wss://vault.test/notifications/hub?access_token=secret');
  const received = vi.fn(); ws.onmessage = received;
  ipc.events!({ type: 'open' });
  expect(ws.readyState).toBe(1);
  ws.send(new Uint8Array([2, 145, 6]).buffer);
  await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('websocket_send', expect.objectContaining({ bytes: [2, 145, 6] })));
  ipc.events!({ type: 'binary', data: [3, 145, 6] });
  expect(new Uint8Array(received.mock.calls[0]![0].data)).toEqual(new Uint8Array([3, 145, 6]));
  ws.close();
});

it('closes a connection cancelled before the native open command finishes', async () => {
  let release!: () => void;
  ipc.invoke.mockImplementation((name: string) => name === 'websocket_open' ? new Promise<void>(r => { release = r; }) : Promise.resolve());
  const ws = new NativeWebSocket('wss://vault.test/notifications/hub');
  const opened = vi.fn(); ws.onopen = opened;
  ws.close();
  ipc.events!({ type: 'open' });
  release();
  await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('websocket_close', expect.any(Object)));
  expect(opened).not.toHaveBeenCalled();
});
