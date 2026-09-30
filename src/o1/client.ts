import type { Address } from 'viem';
import type { Logger } from '../logger.js';
import type {
  ApiEnvelope,
  Configuration,
  LaunchPrepareRequest,
  LaunchPrepareResult,
  Problem,
  Product,
  SwapPrepareRequest,
  SwapPrepareResult,
  SwapQuoteRequest,
  SwapQuoteResult,
} from './types.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly problem?: Problem,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get requestId(): string | undefined {
    return this.problem?.request_id;
  }
}

/** The narrow surface of the o1 API that the rest of the bot depends on. */
export interface O1Api {
  getConfig(chainId: number, opts: { product: Product; market?: 'standard' | 'rwa' | 'all'; activeOnly?: boolean }): Promise<Configuration>;
  /** True when the token is indexed by the API (i.e. visible for swaps), false on 404. */
  tokenIndexed(chainId: number, token: Address): Promise<boolean>;
  prepareLaunch(body: LaunchPrepareRequest, idempotencyKey: string): Promise<LaunchPrepareResult>;
  quoteSwap(body: SwapQuoteRequest): Promise<SwapQuoteResult>;
  prepareSwap(body: SwapPrepareRequest): Promise<SwapPrepareResult>;
}

export interface O1ClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
  /** Longest Retry-After (seconds) that we are willing to sit out automatically. */
  maxRetryAfterSec?: number;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** No legitimate response of this API comes anywhere near this; a bigger one is a misconfigured or hostile endpoint. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class O1Client implements O1Api {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetryAfterSec: number;

  constructor(private readonly opts: O1ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetryAfterSec = opts.maxRetryAfterSec ?? 90;
  }

  async getConfig(
    chainId: number,
    opts: { product: Product; market?: 'standard' | 'rwa' | 'all'; activeOnly?: boolean },
  ): Promise<Configuration> {
    const res = await this.request<Configuration>('GET', '/config', {
      query: {
        chain_id: chainId,
        market: opts.market ?? 'all',
        launch_product: opts.product,
        include: 'chains,suites,quotes',
        active_only: opts.activeOnly ?? true,
      },
    });
    return res.data;
  }

  /** Cheapest authenticated call (1 unit): verifies the API key and its `config:read` scope. */
  async ping(chainId: number): Promise<void> {
    await this.request('GET', '/config', { query: { chain_id: chainId, include: 'chains' } });
  }

  async tokenIndexed(chainId: number, token: Address): Promise<boolean> {
    try {
      await this.request('GET', `/tokens/${chainId}/${token}`, { query: { include: 'pool' } });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return false;
      throw err;
    }
  }

  async prepareLaunch(body: LaunchPrepareRequest, idempotencyKey: string): Promise<LaunchPrepareResult> {
    // Preparation uploads to IPFS and mines the "01" address suffix, so allow it some time.
    const res = await this.request<LaunchPrepareResult>('POST', '/launches/prepare', {
      body,
      idempotencyKey,
      timeoutMs: 90_000,
    });
    return res.data;
  }

  async quoteSwap(body: SwapQuoteRequest): Promise<SwapQuoteResult> {
    const res = await this.request<SwapQuoteResult>('POST', '/swaps/quote', { body });
    return res.data;
  }

  async prepareSwap(body: SwapPrepareRequest): Promise<SwapPrepareResult> {
    const res = await this.request<SwapPrepareResult>('POST', '/swaps/prepare', { body });
    return res.data;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<ApiEnvelope<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { 'x-api-key': this.opts.apiKey, accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);

    const maxAttempts = 6;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers,
          body: payload,
          // Custom headers survive a cross-origin redirect, so an x-api-key must never be sent along one.
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        });
      } catch (err) {
        if (attempt < maxAttempts - 2) {
          this.opts.log?.warn(`o1 API network error on ${method} ${path} (attempt ${attempt}): ${errorText(err)}`);
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new ApiError(0, 'network_error', `Tidak bisa terhubung ke API o1: ${errorText(err)}`);
      }

      if (res.status >= 300 && res.status < 400) {
        throw new ApiError(
          res.status,
          'unexpected_redirect',
          'API o1 mengarahkan permintaan ke alamat lain. Ditolak agar API key tidak terkirim ke tempat yang salah; periksa O1_API_BASE_URL.',
        );
      }
      const declaredLength = Number(res.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new ApiError(res.status, 'response_too_large', 'Respons API o1 terlalu besar; ditolak.');
      }

      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        // The connection broke (or the timeout fired) while the body was still arriving. Every call here is safe
        // to repeat: reads, quotes and plans, and the launch preparation carries its idempotency key.
        if (attempt < maxAttempts - 2) {
          this.opts.log?.warn(`o1 API response body lost on ${method} ${path} (attempt ${attempt}): ${errorText(err)}`);
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new ApiError(0, 'network_error', `Respons API o1 terputus sebelum selesai dibaca: ${errorText(err)}`);
      }
      if (text.length > MAX_RESPONSE_BYTES) throw new ApiError(res.status, 'response_too_large', 'Respons API o1 terlalu besar; ditolak.');
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      if (res.ok) {
        if (!json || typeof json !== 'object' || !('data' in json)) {
          throw new ApiError(res.status, 'invalid_response', `Respons API o1 tidak sesuai format (${method} ${path}).`);
        }
        return json as ApiEnvelope<T>;
      }

      const problem = toProblem(res.status, json, text);
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const error = new ApiError(res.status, problem.code, problem.detail ?? problem.title ?? `HTTP ${res.status}`, problem, retryAfter);

      if (attempt >= maxAttempts) throw error;

      if (res.status === 429 && retryAfter !== undefined && retryAfter <= this.maxRetryAfterSec) {
        this.opts.log?.warn(`o1 API rate limited on ${path}; waiting ${retryAfter}s`);
        await this.sleep(retryAfter * 1000 + 250);
        continue;
      }
      if ([500, 502, 503, 504].includes(res.status) && attempt < maxAttempts - 2) {
        await this.sleep(backoffMs(attempt));
        continue;
      }
      if (res.status === 409 && problem.code === 'idempotency_in_progress') {
        await this.sleep(2000);
        continue;
      }
      throw error;
    }
  }
}

function toProblem(status: number, json: unknown, text: string): Problem {
  if (json && typeof json === 'object' && 'code' in json) {
    return { status, ...(json as Record<string, unknown>) } as Problem;
  }
  return { status, code: `http_${status}`, detail: text.slice(0, 300) || undefined };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
