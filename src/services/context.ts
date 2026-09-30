import { isAddress, zeroAddress, type Address } from 'viem';
import { CHAINS } from '../chains.js';
import type { Draft } from '../domain/draft.js';
import { UserFacingError } from '../errors.js';
import { Catalog, findQuote, suiteForQuote, type CatalogEntry } from '../o1/catalog.js';
import type { ConfigurationCreationFee, ContractSuite, QuoteConfiguration } from '../o1/types.js';

export interface LaunchFee {
  amountRaw: bigint;
  /** Zero address when the fee is paid in the chain's native currency. */
  currency: Address;
  symbol: string;
  decimals: number;
  isNative: boolean;
}

export interface LaunchContext {
  entry: CatalogEntry;
  suite: ContractSuite;
  quote: QuoteConfiguration;
  fee: LaunchFee | null;
  nativeSymbol: string;
  nativeDecimals: number;
}

/** The API reports the fee currency as an address; anything else (or the zero address) means native. */
function toFee(raw: ConfigurationCreationFee | undefined, nativeSymbol: string): LaunchFee | null {
  if (!raw) return null;
  const amount = BigInt(raw.amount_raw);
  if (amount === 0n) return null;
  const isNative = !isAddress(raw.currency) || raw.currency.toLowerCase() === zeroAddress;
  return {
    amountRaw: amount,
    currency: isNative ? zeroAddress : (raw.currency as Address),
    symbol: raw.symbol || nativeSymbol,
    decimals: raw.decimals,
    isNative,
  };
}

/** Resolves catalog, suite, quote and creation fee for a draft, or explains why launching is impossible. */
export async function resolveLaunchContext(
  catalog: Catalog,
  draft: Draft,
  opts: { fresh?: boolean } = {},
): Promise<LaunchContext> {
  if (!draft.quote) throw new UserFacingError('Pair (quote token) belum dipilih.');
  const entry = await catalog.get(draft.chainId, draft.product, { fresh: opts.fresh });
  const quote = findQuote(entry, draft.quote.address);
  if (!quote) {
    throw new UserFacingError(
      `Pair ${draft.quote.symbol} tidak tersedia untuk launch ${draft.product === 'tax' ? 'Tax' : 'Standard'} di chain ini saat ini. Pilih pair lain.`,
    );
  }
  const suite = suiteForQuote(entry, quote);
  if (!suite) throw new UserFacingError('Kontrak launch untuk pair ini tidak ditemukan di konfigurasi o1.');
  const chainInfo = CHAINS[draft.chainId];
  const nativeSymbol = entry.chain?.native_currency.symbol ?? chainInfo?.nativeSymbol ?? 'native';
  const nativeDecimals = entry.chain?.native_currency.decimals ?? chainInfo?.nativeDecimals ?? 18;
  return {
    entry,
    suite,
    quote,
    fee: toFee(quote.creation_fee ?? suite.creation_fee, nativeSymbol),
    nativeSymbol,
    nativeDecimals,
  };
}
