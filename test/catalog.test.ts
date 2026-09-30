import { describe, expect, it, vi } from 'vitest';
import { Catalog, defaultPair, findQuote, listPairs, usableQuotes } from '../src/o1/catalog.js';
import type { O1Api } from '../src/o1/client.js';
import type { Configuration } from '../src/o1/types.js';
import { AAPL, USDC, ZERO, addr, configFor, quote, suite } from './fixtures.js';

function apiWith(cfgFor: (product: string, chainId: number) => Configuration) {
  const getConfig = vi.fn(async (chain: number, opts: { product: string; market?: string }) => cfgFor(opts.product, chain));
  return { api: { getConfig } as unknown as O1Api, getConfig };
}

describe('Catalog', () => {
  it('keeps only the suites of the requested product', async () => {
    const mixed: Configuration = {
      chain: { chain_id: 8453, name: 'Base', native_currency: { symbol: 'ETH', decimals: 18 } },
      suites: [suite('tax'), suite('non-tax')],
      quotes: [quote(suite('tax').id, ZERO, 'ETH'), quote(suite('non-tax').id, ZERO, 'ETH')],
    };
    const { api } = apiWith(() => mixed);
    const catalog = new Catalog(api);
    const tax = await catalog.get(8453, 'tax');
    expect(tax.suites.map((s) => s.launch_product)).toEqual(['tax']);
    expect(tax.quotes).toHaveLength(1);
    const std = await catalog.get(8453, 'non-tax');
    expect(std.suites.map((s) => s.launch_product)).toEqual(['non-tax']);
  });

  it('caches within the TTL, refreshes after it, and honours fresh', async () => {
    const { api, getConfig } = apiWith((p) => configFor(p as 'tax'));
    let now = 1_000;
    const catalog = new Catalog(api, 60_000, () => now);
    await catalog.get(8453, 'tax');
    await catalog.get(8453, 'tax');
    expect(getConfig).toHaveBeenCalledTimes(1);
    now += 61_000;
    await catalog.get(8453, 'tax');
    expect(getConfig).toHaveBeenCalledTimes(2);
    await catalog.get(8453, 'tax', { fresh: true });
    expect(getConfig).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const { api, getConfig } = apiWith((p) => configFor(p as 'tax'));
    const catalog = new Catalog(api);
    await Promise.all([catalog.get(8453, 'tax'), catalog.get(8453, 'tax'), catalog.get(8453, 'tax')]);
    expect(getConfig).toHaveBeenCalledTimes(1);
  });

  it('asks for stock markets only on chains that have them (Monad and Arc are crypto-only)', async () => {
    const { api, getConfig } = apiWith((p, chain) => configFor(p as 'tax', chain));
    const catalog = new Catalog(api);
    for (const chain of [8453, 4663, 56, 196, 143, 5042]) await catalog.get(chain, 'tax');
    const markets = Object.fromEntries(getConfig.mock.calls.map(([chain, opts]) => [chain, opts.market]));
    expect(markets).toEqual({ 8453: 'all', 4663: 'all', 56: 'all', 196: 'all', 143: 'standard', 5042: 'standard' });
  });

  it('never lets a suite of another chain into the catalog (its addresses would be trusted by the guard)', async () => {
    const mixed: Configuration = {
      chain: { chain_id: 8453, name: 'Base', native_currency: { symbol: 'ETH', decimals: 18 } },
      suites: [suite('tax', 8453), { ...suite('tax', 56), id: 'bsc-tax' }],
      quotes: [quote(suite('tax', 8453).id, ZERO, 'ETH'), quote('bsc-tax', USDC, 'USDC')],
    };
    const entry = await new Catalog(apiWith(() => mixed).api).get(8453, 'tax');
    expect(entry.suites.map((s) => s.chain_id)).toEqual([8453]);
    expect(entry.quotes.map((q) => q.symbol)).toEqual(['ETH']);
  });

  it('rejects a configuration that answers for another chain than the one asked', async () => {
    const { api } = apiWith(() => configFor('tax', 56));
    await expect(new Catalog(api).get(8453, 'tax')).rejects.toThrow(/konfigurasi chain 56, bukan 8453/);
  });

  it('does not cache failures', async () => {
    const getConfig = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(configFor('tax'));
    const catalog = new Catalog({ getConfig } as unknown as O1Api);
    await expect(catalog.get(8453, 'tax')).rejects.toThrow('boom');
    await expect(catalog.get(8453, 'tax')).resolves.toBeDefined();
  });
});

describe('quote helpers', () => {
  const entry = async () => new Catalog(apiWith((p) => configFor(p as 'tax')).api).get(8453, 'tax');

  it('sorts native first, then stablecoins, and splits crypto from stocks', async () => {
    const e = await entry();
    expect(listPairs(e, 'crypto').map((q) => q.symbol)).toEqual(['ETH', 'USDC']);
    expect(listPairs(e, 'stocks').map((q) => q.symbol)).toEqual(['AAPL']);
  });

  it('searches by symbol or name, case-insensitively', async () => {
    const e = await entry();
    expect(listPairs(e, 'crypto', 'usd').map((q) => q.symbol)).toEqual(['USDC']);
    expect(listPairs(e, 'stocks', 'zzz')).toEqual([]);
  });

  it('hides unregistered, unselectable and creation-disabled quotes', async () => {
    const e = await entry();
    const s = e.suites[0]!;
    e.quotes.push(quote(s.id, addr(0x9001), 'OFF', { selectable: false }));
    e.quotes.push(quote(s.id, addr(0x9002), 'UNREG', { registered: false }));
    expect(usableQuotes(e).map((q) => q.symbol)).not.toContain('OFF');
    expect(usableQuotes(e).map((q) => q.symbol)).not.toContain('UNREG');
    s.creation_available = false;
    expect(usableQuotes(e)).toEqual([]);
  });

  it('finds a quote by address ignoring case and picks native as default', async () => {
    const e = await entry();
    expect(findQuote(e, USDC.toUpperCase().replace('0X', '0x') as never)?.symbol).toBe('USDC');
    expect(findQuote(e, AAPL)?.symbol).toBe('AAPL');
    expect(defaultPair(e)?.symbol).toBe('ETH');
  });

  it('falls back to the first crypto quote when the native one is unavailable', async () => {
    const e = await entry();
    e.quotes = e.quotes.filter((q) => q.address !== ZERO);
    expect(defaultPair(e)?.symbol).toBe('USDC');
  });
});
