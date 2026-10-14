import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeServer } from './server-probe';

const config = { object: 'config', version: '2026.1.0', server: { name: 'Vaultwarden' } };
const configResponse = () => Response.json(config);

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('public server latency probe', () => {
  it.each(['', 'example.com', 'ftp://example.com', 'https://person:secret@example.com',
    'https://example.com?token=secret', 'https://example.com#vault'])('rejects an invalid server before any request: %s', async serverUrl => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(probeServer(serverUrl, { mode: 'latency', fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [' https://VAULT.BITWARDEN.COM:443/ ', 'https://vault.bitwarden.com', 'https://api.bitwarden.com/config'],
    ['https://vault.bitwarden.eu', 'https://vault.bitwarden.eu', 'https://api.bitwarden.eu/config'],
    ['https://example.com/team/', 'https://example.com/team', 'https://example.com/team/api/config'],
  ])('normalizes %s and measures three credential-free uncached config requests', async (input, normalized, endpoint) => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const times = [30, 10, 20];
    const requests: { url: URL; init: RequestInit & { timeoutMs?: number; maxResponseBytes?: number } }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ url: new URL(String(url)), init: init! });
      clock += times.shift()!;
      return configResponse();
    };
    const result = await probeServer(input!, { mode: 'latency', fetchImpl });
    expect(result).toEqual({ serverUrl: normalized, latencyMs: 20, samples: 3, download: null, downloadNote: null });
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map(({ url }) => url.search)).size).toBe(3);
    for (const { url, init } of requests) {
      expect(`${url.origin}${url.pathname}`).toBe(endpoint);
      expect(url.search).not.toBe('');
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', timeoutMs: 4000, maxResponseBytes: 65536 });
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).has('authorization')).toBe(false);
      expect(new Headers(init.headers).has('cookie')).toBe(false);
    }
  });

  it('reports the median of successful full-response timings without counting invalid responses', async () => {
    let clock = 0;
    let count = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const fetchImpl: typeof fetch = async () => {
      count++;
      clock += count === 1 ? 80 : count === 2 ? 10 : 20;
      return count === 2 ? new Response('<html>login</html>') : configResponse();
    };
    const result = await probeServer('https://example.com', { mode: 'latency', fetchImpl });
    expect(result.samples).toBe(2);
    expect(result.latencyMs).toBe(50);
  });

  it.each([() => new Response('<html>login</html>'), () => Response.json({}),
    () => Response.json({ object: 'config' }), () => new Response('[]'),
    () => new Response('blocked', { status: 403 }),
  ])('does not accept an unrelated or failed response as a working server', async response => {
    await expect(probeServer('https://example.com', { mode: 'latency', fetchImpl: async () => response() })).rejects.toThrow(/延迟/);
  });

  it('measures fresh network requests served by a CDN cache', async () => {
    const result = await probeServer('https://example.com', {
      mode: 'latency', fetchImpl: async () => new Response(JSON.stringify(config), {
        headers: { Age: '120', 'x-cache': 'HIT', 'cf-cache-status': 'HIT' },
      }),
    });
    expect(result.samples).toBe(3);
  });

  it('enforces deadlines even when fetch ignores the abort signal', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      signals.push(init!.signal!);
      return new Promise(() => {});
    };
    const outcome = probeServer('https://example.com', { mode: 'latency', fetchImpl }).catch(error => error);
    await vi.advanceTimersByTimeAsync(12001);
    expect(await outcome).toMatchObject({ kind: 'timeout' });
    expect(signals).toHaveLength(3);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it.each(['certUntrusted', 'auth', 'timeout'])('preserves the transport classification %s when all config requests fail', async kind => {
    const failure = Object.assign(new Error('Connection failed'), { kind, fingerprint: 'AA:BB' });
    await expect(probeServer('https://example.com', {
      mode: 'latency', fetchImpl: async () => { throw failure; },
    })).rejects.toMatchObject({ kind, fingerprint: 'AA:BB' });
  });

  it('classifies a protected public configuration as an authentication failure', async () => {
    await expect(probeServer('https://example.com', {
      mode: 'latency', fetchImpl: async () => new Response(null, { status: 401 }),
    })).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('aborts promptly and never starts another request after a stale fetch resolves', async () => {
    const controller = new AbortController();
    let resolve!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(done => { resolve = done; }));
    const outcome = probeServer('https://example.com', { mode: 'full', fetchImpl, signal: controller.signal }).catch(error => error);
    controller.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    resolve(configResponse());
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not request anything when already canceled', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(probeServer('https://example.com', { mode: 'full', fetchImpl, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels config streams over 64 KiB and rejects them as latency samples', async () => {
    const cancellations: unknown[] = [];
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65537)); },
      cancel(reason) { cancellations.push(reason); },
    }));
    await expect(probeServer('https://example.com', { mode: 'latency', fetchImpl })).rejects.toThrow(/延迟/);
    expect(cancellations).toHaveLength(3);
  });

  it('applies the same deadline while a response body stalls', async () => {
    vi.useFakeTimers();
    let canceled = 0;
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({ cancel() { canceled++; } }));
    const outcome = probeServer('https://example.com', { mode: 'latency', fetchImpl }).catch(error => error);
    await vi.advanceTimersByTimeAsync(12001);
    expect(await outcome).toBeInstanceOf(Error);
    expect(canceled).toBe(3);
  });
});

/** The fetch boundary is the only fake: parsing, limits, cancellation, and calculations are real. */
function fullFixture(respond: (url: URL, index: number, init: RequestInit & { maxResponseBytes?: number }) => Response | Promise<Response>, vaultwarden = true) {
  let clock = 0;
  let assets = 0;
  const requests: { url: URL; init: RequestInit & { maxResponseBytes?: number; timeoutMs?: number } }[] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init: init! });
    if (url.pathname.endsWith('/config')) {
      clock += 5;
      return Response.json(vaultwarden ? config : { object: 'config', version: '2026.1.0' });
    }
    clock += 100;
    return respond(url, assets++, init!);
  };
  return { fetchImpl, requests };
}
function css(bytes: number, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes).fill(32), { headers: { 'content-type': 'text/css', ...headers } });
}

describe('bounded public download reference', () => {
  it('uses Vaultwarden public CSS under the selected subpath and includes request time', async () => {
    const fixture = fullFixture(() => css(131072));
    const result = await probeServer('https://example.com/team', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(result.download).toEqual({ bytes: 131072, durationMs: 100, bytesPerSecond: 1310720 });
    expect(result.downloadNote).toBeNull();
    expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
      '/team/api/config', '/team/api/config', '/team/api/config', '/team/vw_static/bootstrap.css',
    ]);
    expect(fixture.requests[3]!.init).toMatchObject({ timeoutMs: 8000, maxResponseBytes: 2097152, credentials: 'omit', cache: 'no-store', redirect: 'error' });
  });

  it('uses the second known public Vaultwarden asset when CSS provides too small a sample', async () => {
    const fixture = fullFixture((_url, index) => index === 0 ? css(32768) : css(131072, { 'content-type': 'application/javascript' }));
    const result = await probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(fixture.requests.map(({ url }) => url.pathname).slice(3)).toEqual(['/vw_static/bootstrap.css', '/vw_static/datatables.js']);
    expect(result.download).toEqual({ bytes: 163840, durationMs: 200, bytesPerSecond: 819200 });
  });

  it('uses encoded Content-Length for complete compressed bodies and charges decoded memory against the cap', async () => {
    const fixture = fullFixture((_url, index) => css(262144, {
      'content-encoding': 'gzip', 'content-length': String(index === 0 ? 32768 : 98304),
    }));
    const result = await probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(result.download).toEqual({ bytes: 131072, durationMs: 200, bytesPerSecond: 655360 });
  });

  it.each(['', 'banana', '-1', '0', '1.5', '9000000000'])('does not invent wire bytes for compressed responses with invalid length %s', async length => {
    const fixture = fullFixture(() => css(131072, { 'content-encoding': 'br', ...(length ? { 'content-length': length } : {}) }));
    const result = await probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(result.download).toBeNull();
    expect(result.downloadNote).toBeTruthy();
  });

  it('discovers at most two same-origin public static assets without executing HTML or retaining its query strings', async () => {
    const page = `<!doctype html>
      <!-- <script src="/comment.js"></script> -->
      <base href="https://outside.example/">
      <script src="https://outside.example/a.js"></script>
      <script src="https://user:secret@example.com/user.js"></script>
      <script src="//example.com.evil.test/evil.js"></script>
      <script src="blob:https://example.com/local.js"></script>
      <script src="/api/auth.js"></script>
      <script src="/%69dentity/token.js"></script>
      <script src="/%2569dentity/token.js"></script>
      <script src="/nested/%2fidentity/auth.js"></script>
      <script src="javascript:alert(1)"></script>
      <link rel="alternate" href="/not-style.css">
      <script>throw Error('must never run')</script>
      <link rel="stylesheet" href="assets/main.css?token=do-not-send#fragment">
      <script src="./assets/main.js?email=do-not-send"></script>
      <script src="assets/third.js"></script>`;
    const fixture = fullFixture((url, index) => index === 0
      ? new Response(page, { headers: { 'content-type': 'text/html' } })
      : css(index === 1 ? 32768 : 131072, { 'content-type': url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css' }), false);
    const result = await probeServer('https://example.com/team', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(fixture.requests.map(({ url }) => url.pathname).slice(3)).toEqual(['/team/', '/team/assets/main.css', '/team/assets/main.js']);
    expect(fixture.requests.every(({ url }) => url.origin === 'https://example.com')).toBe(true);
    for (const { url } of fixture.requests) expect(Array.from(url.searchParams.keys())).toEqual(['_1warden_probe']);
    expect(result.download?.bytes).toBe(163840);
  });

  it('uses the cloud web-vault origin for public assets, independently of its API origin', async () => {
    const fixture = fullFixture((_url, index) => index === 0
      ? new Response('<script src="main.js"></script>', { headers: { 'content-type': 'text/html' } })
      : css(131072, { 'content-type': 'application/javascript' }), false);
    const result = await probeServer('https://vault.bitwarden.eu', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(fixture.requests.map(({ url }) => `${url.origin}${url.pathname}`)).toEqual([
      'https://api.bitwarden.eu/config', 'https://api.bitwarden.eu/config', 'https://api.bitwarden.eu/config',
      'https://vault.bitwarden.eu/', 'https://vault.bitwarden.eu/main.js',
    ]);
    expect(result.download).not.toBeNull();
  });

  it('uses the complete response Content-Length when CORS hides its compression header', async () => {
    const fixture = fullFixture(() => {
      const response = css(262144, { 'content-length': '131072' });
      vi.spyOn(response, 'type', 'get').mockReturnValue('cors');
      return response;
    });
    const result = await probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(result.download).toEqual({ bytes: 131072, durationMs: 100, bytesPerSecond: 1310720 });
  });

  it('refuses a CORS sample when both transfer length and compression are hidden', async () => {
    const fixture = fullFixture(() => {
      const response = css(262144);
      vi.spyOn(response, 'type', 'get').mockReturnValue('cors');
      return response;
    });
    const result = await probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(result.download).toBeNull();
    expect(result.downloadNote).toMatch(/可验证的传输大小/);
    expect(result.samples).toBe(3);
  });

  it('counts an uncompressed CORS body when identity encoding is explicitly visible', async () => {
    const fixture = fullFixture(() => {
      const response = css(131072, { 'content-encoding': 'identity' });
      vi.spyOn(response, 'type', 'get').mockReturnValue('cors');
      return response;
    });
    const result = await probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(result.download).toEqual({ bytes: 131072, durationMs: 100, bytesPerSecond: 1310720 });
  });

  it('explains when there are no suitable public assets while preserving latency', async () => {
    const fixture = fullFixture(() => new Response('<html><h1>Login</h1></html>'), false);
    const result = await probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(result.samples).toBe(3);
    expect(result.download).toBeNull();
    expect(result.downloadNote).toBeTruthy();
    expect(fixture.requests).toHaveLength(4);
  });

  it('does not present tiny resources or HTML fallback bodies as a speed measurement', async () => {
    const fixture = fullFixture((_url, index) => index === 0 ? css(4096) : new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
    const result = await probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(result.download).toBeNull();
    expect(result.downloadNote).toMatch(/小|不足/);
  });

  it('does not report a throughput when request duration is below clock resolution', async () => {
    const fixture = fullFixture(() => css(131072));
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const result = await probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(result.download).toBeNull();
    expect(result.downloadNote).toMatch(/短|快/);
  });

  it('cancels an oversized asset and keeps the total allowance within four MiB including config', async () => {
    let canceled = 0;
    const fixture = fullFixture((_url, _index, init) => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(init.maxResponseBytes! + 1)); },
      cancel() { canceled++; },
    }), { headers: { 'content-type': 'text/css' } }));
    const result = await probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    const configBytes = new TextEncoder().encode(JSON.stringify(config)).byteLength * 3;
    const assetCaps = fixture.requests.slice(3).map(({ init }) => init.maxResponseBytes!);
    expect(assetCaps).toHaveLength(2);
    expect(assetCaps.reduce((sum, cap) => sum + cap, configBytes)).toBe(4194304);
    expect(canceled).toBe(2);
    expect(result.download).toBeNull();
    expect(result.downloadNote).toBeTruthy();
  });

  it('bounds the discovery HTML to 128 KiB before parsing candidates', async () => {
    let canceled = false;
    const fixture = fullFixture(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('<script src="/main.js"></script>' + ' '.repeat(131072))); },
      cancel() { canceled = true; },
    }), { headers: { 'content-type': 'text/html' } }), false);
    const result = await probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    expect(canceled).toBe(true);
    expect(fixture.requests).toHaveLength(4);
    expect(result.download).toBeNull();
    expect(result.downloadNote).toBeTruthy();
  });

  it('aborts a stalled download without requesting a fallback asset', async () => {
    const controller = new AbortController();
    let enteredDownload!: () => void;
    const entered = new Promise<void>(resolve => { enteredDownload = resolve; });
    const fixture = fullFixture(() => { enteredDownload(); return new Promise<Response>(() => {}); });
    const outcome = probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl, signal: controller.signal }).catch(error => error);
    await entered;
    controller.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(fixture.requests).toHaveLength(4);
  });

  it('returns latency after the bounded download attempts time out even if fetch ignores abort', async () => {
    vi.useFakeTimers();
    const fixture = fullFixture(() => new Promise<Response>(() => {}));
    const outcome = probeServer('https://example.com', { mode: 'full', fetchImpl: fixture.fetchImpl });
    await vi.advanceTimersByTimeAsync(16001);
    const result = await outcome;
    expect(result.download).toBeNull();
    expect(result.downloadNote).toBeTruthy();
    expect(fixture.requests).toHaveLength(5);
    expect(fixture.requests.slice(3).every(({ init }) => init.signal!.aborted)).toBe(true);
  });
});
