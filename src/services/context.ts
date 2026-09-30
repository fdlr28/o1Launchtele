import { isAddress, zeroAddress, type Address } from 'viem';
import { CHAINS, DEFAULT_MAX_CREATION_FEE_WEI } from '../chains.js';
import type { Draft } from '../domain/draft.js';
import { UserFacingError } from '../errors.js';
import { Catalog, findQuote, isNativeQuote, suiteForQuote, type CatalogEntry } from '../o1/catalog.js';
import type { ConfigurationCreationFee, ContractSuite, QuoteConfiguration } from '../o1/types.js';

/** The most a native creation fee may be on a chain (wei): the owner's override, else the built-in ceiling. */
export function creationFeeCap(chainId: number, override?: (chainId: number) => bigint | undefined): bigint {
  return override?.(chainId) ?? CHAINS[chainId]?.maxCreationFeeWei ?? DEFAULT_MAX_CREATION_FEE_WEI;
}

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

export interface ResolveOptions {
  fresh?: boolean;
  /**
   * Reads a token's `decimals()` on chain. The API's own decimals are only believed when they agree with it: a
   * decimals field that lies would make a whole balance look like a rounding error in the review.
   */
  tokenDecimals?: (token: Address) => Promise<number>;
}

/** The API reports the fee currency as an address; anything else (or the zero address) means native. */
async function toFee(
  raw: ConfigurationCreationFee | undefined,
  native: { symbol: string; decimals: number },
  tokenDecimals: ResolveOptions['tokenDecimals'],
): Promise<LaunchFee | null> {
  if (!raw) return null;
  if (!/^\d+$/.test(String(raw.amount_raw))) throw new UserFacingError('API o1 memberi creation fee yang bukan angka.');
  const amount = BigInt(raw.amount_raw);
  if (amount === 0n) return null;
  const isNative = !isAddress(raw.currency) || raw.currency.toLowerCase() === zeroAddress;
  if (isNative) {
    // The native currency of a chain has fixed decimals and the API does not get to redefine them: a number of
    // decimals that differs from ours would make the amount shown in the review mean something else than what is paid.
    if (raw.decimals !== native.decimals) {
      throw new UserFacingError(
        `Desimal creation fee menurut API o1 (${raw.decimals}) tidak sama dengan mata uang native chain ini (${native.decimals}). Dibatalkan demi keamanan.`,
      );
    }
    return { amountRaw: amount, currency: zeroAddress, symbol: native.symbol, decimals: native.decimals, isNative: true };
  }
  const currency = raw.currency as Address;
  const decimals = tokenDecimals ? await tokenDecimals(currency) : raw.decimals;
  if (decimals !== raw.decimals) {
    throw new UserFacingError(
      `Desimal token creation fee menurut API o1 (${raw.decimals}) tidak cocok dengan kontrak token ${currency} (${decimals}). Dibatalkan demi keamanan.`,
    );
  }
  return { amountRaw: amount, currency, symbol: raw.symbol || 'token', decimals, isNative: false };
}

/** Resolves catalog, suite, quote and creation fee for a draft, or explains why launching is impossible. */
export async function resolveLaunchContext(catalog: Catalog, draft: Draft, opts: ResolveOptions = {}): Promise<LaunchContext> {
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
  // What the chain is (symbol, decimals) comes from our own table first; the API only fills in unknown chains.
  const chainInfo = CHAINS[draft.chainId];
  const nativeSymbol = chainInfo?.nativeSymbol ?? entry.chain?.native_currency.symbol ?? 'native';
  const nativeDecimals = chainInfo?.nativeDecimals ?? entry.chain?.native_currency.decimals ?? 18;

  // The pair's decimals decide how "0.05" becomes a raw amount: for an ERC-20 they must be what the token itself says.
  // (A native pair has no contract to ask; a wrong number there only makes the buy smaller, or the balance check fail.)
  if (draft.quote.decimals !== quote.decimals) {
    throw new UserFacingError(`Desimal pair ${draft.quote.symbol} berubah sejak dipilih (${draft.quote.decimals} → ${quote.decimals}). Pilih ulang pair-nya.`);
  }
  if (!isNativeQuote(quote) && opts.tokenDecimals) {
    const onChain = await opts.tokenDecimals(quote.address);
    if (onChain !== quote.decimals) {
      throw new UserFacingError(
        `Desimal pair ${draft.quote.symbol} menurut API o1 (${quote.decimals}) tidak cocok dengan kontrak token ${quote.address} (${onChain}). Dibatalkan demi keamanan.`,
      );
    }
  }

  return {
    entry,
    suite,
    quote,
    fee: await toFee(quote.creation_fee ?? suite.creation_fee, { symbol: nativeSymbol, decimals: nativeDecimals }, opts.tokenDecimals),
    nativeSymbol,
    nativeDecimals,
  };
}
