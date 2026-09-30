import { zeroAddress, type Address } from 'viem';
import { STOCK_CHAIN_IDS } from '../chains.js';
import { UserFacingError } from '../errors.js';
import type { O1Api } from './client.js';
import type { ChainConfiguration, ContractSuite, Product, QuoteConfiguration, Route } from './types.js';

export interface CatalogEntry {
  chainId: number;
  product: Product;
  chain?: ChainConfiguration;
  suites: ContractSuite[];
  quotes: QuoteConfiguration[];
  fetchedAt: number;
}

const ASSET_ORDER: Record<string, number> = {
  native: 0,
  stablecoin: 1,
  wrapped_crypto: 2,
  crypto_token: 3,
  tokenized_security: 4,
};

/** Cached view of GET /config per (chain, product). */
export class Catalog {
  private readonly cache = new Map<string, CatalogEntry>();
  private readonly inflight = new Map<string, Promise<CatalogEntry>>();

  constructor(
    private readonly api: O1Api,
    private readonly ttlMs = 120_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(chainId: number, product: Product, opts: { fresh?: boolean } = {}): Promise<CatalogEntry> {
    const key = `${chainId}:${product}`;
    const cached = this.cache.get(key);
    if (!opts.fresh && cached && this.now() - cached.fetchedAt < this.ttlMs) return cached;

    const pending = this.inflight.get(key);
    if (pending && !opts.fresh) return pending;

    const request = this.load(chainId, product)
      .then((entry) => {
        this.cache.set(key, entry);
        return entry;
      })
      .finally(() => {
        if (this.inflight.get(key) === request) this.inflight.delete(key);
      });
    this.inflight.set(key, request);
    return request;
  }

  private async load(chainId: number, product: Product): Promise<CatalogEntry> {
    const cfg = await this.api.getConfig(chainId, { product, market: STOCK_CHAIN_IDS.has(chainId) ? 'all' : 'standard', activeOnly: true });
    if (cfg.chain && cfg.chain.chain_id !== chainId) {
      throw new UserFacingError(`API o1 mengembalikan konfigurasi chain ${cfg.chain.chain_id}, bukan ${chainId}.`);
    }
    const wantsTax = product === 'tax';
    // The contract addresses of a suite become the guard's allow-list, so a suite of another chain must never get in.
    const suites = (cfg.suites ?? []).filter(
      (s) => s.chain_id === chainId && (wantsTax ? s.launch_product === 'tax' : s.launch_product !== 'tax'),
    );
    const suiteIds = new Set(suites.map((s) => s.id));
    const quotes = (cfg.quotes ?? []).filter((q) => suiteIds.has(q.suite_id));
    return { chainId, product, chain: cfg.chain, suites, quotes, fetchedAt: this.now() };
  }
}

export function suiteForQuote(entry: CatalogEntry, quote: QuoteConfiguration): ContractSuite | undefined {
  return entry.suites.find((s) => s.id === quote.suite_id);
}

/** Quotes that can be used to create a new launch right now. */
export function usableQuotes(entry: CatalogEntry): QuoteConfiguration[] {
  return entry.quotes.filter((q) => {
    if (q.registered === false || q.selectable === false) return false;
    const suite = suiteForQuote(entry, q);
    return !!suite && suite.creation_available === true && suite.supported_routes.includes(q.route);
  });
}

export function findQuote(entry: CatalogEntry, address: Address): QuoteConfiguration | undefined {
  const wanted = address.toLowerCase();
  return usableQuotes(entry).find((q) => q.address.toLowerCase() === wanted);
}

export function isNativeQuote(quote: { address: Address }): boolean {
  return quote.address.toLowerCase() === zeroAddress;
}

function rank(quote: QuoteConfiguration): number {
  if (isNativeQuote(quote)) return -1;
  return ASSET_ORDER[quote.asset_type ?? ''] ?? 9;
}

export type PairFilter = 'crypto' | 'stocks';

export function routeForFilter(filter: PairFilter): Route {
  return filter === 'crypto' ? 'standard' : 'rwa';
}

/** Sorted, optionally searched list of usable quotes for the pair picker. */
export function listPairs(entry: CatalogEntry, filter: PairFilter, query = ''): QuoteConfiguration[] {
  const route = routeForFilter(filter);
  const needle = query.trim().toLowerCase();
  return usableQuotes(entry)
    .filter((q) => q.route === route)
    .filter((q) => !needle || q.symbol.toLowerCase().includes(needle) || (q.name ?? '').toLowerCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));
}

/** The pair to pre-select for a new draft: the chain's native currency when it is usable. */
export function defaultPair(entry: CatalogEntry): QuoteConfiguration | undefined {
  const usable = usableQuotes(entry).filter((q) => q.route === 'standard');
  return usable.find(isNativeQuote) ?? usable[0];
}
