import { describe, expect, it, vi } from 'vitest';
import { ApiError, O1Client } from '../src/o1/client.js';
import { TOKEN } from './fixtures.js';

interface Call {
  url: URL;
  init: RequestInit;
}

function envelope(data: unknown) {
  return { data, meta: { request_id: 'req_1', generated_at: 'now', warnings: [] } };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers },
  });
}

function setup(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(url.toString()), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error('no more mocked responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const client = new O1Client({
    baseUrl: 'https://api.example.test/v1/',
    apiKey: 'o1_launch_abcdef12_secretsecret',
    fetch: fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}

describe('O1Client', () => {
  it('sends the API key and builds the config query', async () => {
    const { client, calls } = setup([jsonResponse(200, envelope({ suites: [], quotes: [] }))]);
    await client.getConfig(8453, { product: 'tax' });
    const call = calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe('https://api.example.test/v1/config');
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      chain_id: '8453',
      market: 'all',
      launch_product: 'tax',
      include: 'chains,suites,quotes',
      active_only: 'true',
    });
    expect((call.init.headers as Record<string, string>)['x-api-key']).toBe('o1_launch_abcdef12_secretsecret');
  });

  it('passes an explicit market and defaults to all', async () => {
    const { client, calls } = setup([jsonResponse(200, envelope({})), jsonResponse(200, envelope({}))]);
    await client.getConfig(143, { product: 'tax', market: 'standard' });
    await client.getConfig(8453, { product: 'tax' });
    expect(calls[0]!.url.searchParams.get('market')).toBe('standard');
    expect(calls[1]!.url.searchParams.get('market')).toBe('all');
  });

  it('ping is a cheap chains-only config call', async () => {
    const { client, calls } = setup([jsonResponse(200, envelope({}))]);
    await client.ping(8453);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ chain_id: '8453', include: 'chains' });
  });

  it('posts JSON with the idempotency key', async () => {
    const { client, calls } = setup([jsonResponse(200, envelope({ predicted_token_address: TOKEN }))]);
    await client.prepareLaunch({ chain_id: 8453 } as never, 'key-123');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.init.method).toBe('POST');
    expect(headers['idempotency-key']).toBe('key-123');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ chain_id: 8453 });
  });

  it('turns problem+json into an ApiError with all fields', async () => {
    const { client } = setup([
      jsonResponse(422, {
        type: 'https://docs.o1.exchange/x',
        title: 'Insufficient balance',
        status: 422,
        code: 'insufficient_balance',
        detail: 'not enough',
        action: 'fund the wallet',
        request_id: 'req_9',
        asset: '0x0000000000000000000000000000000000000000',
        actual_raw: '5',
        required_raw: '10',
      }),
    ]);
    const err = (await client.prepareLaunch({} as never, 'k').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('insufficient_balance');
    expect(err.requestId).toBe('req_9');
    expect(err.problem?.required_raw).toBe('10');
  });

  it('waits for Retry-After on 429 and retries with the same body and key', async () => {
    const { client, calls, sleeps } = setup([
      jsonResponse(429, { status: 429, code: 'rate_limit_exceeded' }, { 'retry-after': '7' }),
      jsonResponse(200, envelope({ ok: true })),
    ]);
    await client.prepareLaunch({ a: 1 } as never, 'same-key');
    expect(calls).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(7000);
    expect((calls[1]!.init.headers as Record<string, string>)['idempotency-key']).toBe('same-key');
    expect(calls[1]!.init.body).toBe(calls[0]!.init.body);
  });

  it('does not sit out an unreasonably long Retry-After', async () => {
    const { client, calls } = setup([jsonResponse(429, { status: 429, code: 'quota_exceeded' }, { 'retry-after': '3600' })]);
    const err = (await client.getConfig(8453, { product: 'tax' }).catch((e) => e)) as ApiError;
    expect(err.code).toBe('quota_exceeded');
    expect(err.retryAfterSec).toBe(3600);
    expect(calls).toHaveLength(1);
  });

  it('retries 503 and network errors with backoff', async () => {
    const { client, calls, sleeps } = setup([
      new Error('socket hang up'),
      jsonResponse(503, { status: 503, code: 'temporarily_unavailable' }),
      jsonResponse(200, envelope({ suites: [] })),
    ]);
    const cfg = await client.getConfig(8453, { product: 'non-tax' });
    expect(cfg).toEqual({ suites: [] });
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it('gives up after repeated failures', async () => {
    const failures = Array.from({ length: 10 }, () => jsonResponse(502, { status: 502, code: 'upstream_error' }));
    const { client, calls } = setup(failures);
    const err = (await client.getConfig(8453, { product: 'tax' }).catch((e) => e)) as ApiError;
    expect(err.code).toBe('upstream_error');
    expect(calls.length).toBeLessThan(10);
  });

  it('does not retry client errors', async () => {
    const { client, calls } = setup([jsonResponse(403, { status: 403, code: 'insufficient_scope', detail: 'needs launches:prepare' })]);
    const err = (await client.prepareLaunch({} as never, 'k').catch((e) => e)) as ApiError;
    expect(err.code).toBe('insufficient_scope');
    expect(calls).toHaveLength(1);
  });

  it('retries while an identical request is still in progress', async () => {
    const { client, calls } = setup([
      jsonResponse(409, { status: 409, code: 'idempotency_in_progress' }),
      jsonResponse(200, envelope({ done: true })),
    ]);
    await client.prepareLaunch({} as never, 'k');
    expect(calls).toHaveLength(2);
  });

  it('tokenIndexed maps 404 to false and 200 to true', async () => {
    const { client } = setup([jsonResponse(404, { status: 404, code: 'not_found' }), jsonResponse(200, envelope({ token: {} }))]);
    expect(await client.tokenIndexed(8453, TOKEN)).toBe(false);
    expect(await client.tokenIndexed(8453, TOKEN)).toBe(true);
  });

  it('tokenIndexed propagates other errors (e.g. a bad key)', async () => {
    const { client } = setup([jsonResponse(401, { status: 401, code: 'invalid_api_key' })]);
    await expect(client.tokenIndexed(8453, TOKEN)).rejects.toMatchObject({ code: 'invalid_api_key' });
  });

  describe('hostile or broken responses', () => {
    it('never follows a redirect (the API key must not travel to another host) and does not retry it', async () => {
      const { client, calls } = setup([
        new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
        jsonResponse(200, envelope({})),
      ]);
      const err = (await client.getConfig(8453, { product: 'tax' }).catch((e) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('unexpected_redirect');
      expect(err.message).toContain('O1_API_BASE_URL');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.redirect).toBe('manual');
    });

    it('retries when the body is lost mid-transfer, then succeeds', async () => {
      const broken = new Response('x', { status: 200 });
      vi.spyOn(broken, 'text').mockRejectedValueOnce(new TypeError('terminated'));
      const { client, calls, sleeps } = setup([broken, jsonResponse(200, envelope({ suites: [] }))]);
      await expect(client.getConfig(8453, { product: 'tax' })).resolves.toEqual({ suites: [] });
      expect(calls).toHaveLength(2);
      expect(sleeps).toHaveLength(1);
    });

    it('retries a lost preparation body with the very same idempotency key', async () => {
      const broken = new Response('x', { status: 200 });
      vi.spyOn(broken, 'text').mockRejectedValueOnce(new TypeError('terminated'));
      const { client, calls } = setup([broken, jsonResponse(200, envelope({ predicted_token_address: TOKEN }))]);
      await client.prepareLaunch({ a: 1 } as never, 'stable-key');
      expect(calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key'])).toEqual(['stable-key', 'stable-key']);
    });

    it('gives up with a network error when the body keeps getting lost', async () => {
      const bodies = Array.from({ length: 8 }, () => {
        const res = new Response('x', { status: 200 });
        vi.spyOn(res, 'text').mockRejectedValue(new TypeError('terminated'));
        return res;
      });
      const { client, calls } = setup(bodies);
      const err = (await client.getConfig(8453, { product: 'tax' }).catch((e) => e)) as ApiError;
      expect(err.code).toBe('network_error');
      expect(err.message).toContain('terputus');
      expect(calls.length).toBeLessThan(8);
    });

    it('refuses an absurdly large response before reading it', async () => {
      const huge = new Response('{}', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } });
      const textSpy = vi.spyOn(huge, 'text');
      const { client } = setup([huge]);
      await expect(client.getConfig(8453, { product: 'tax' })).rejects.toMatchObject({ code: 'response_too_large' });
      expect(textSpy).not.toHaveBeenCalled();
    });
  });

  it('reports a malformed success body', async () => {
    const { client } = setup([new Response('<html>oops</html>', { status: 200 })]);
    await expect(client.getConfig(8453, { product: 'tax' })).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
