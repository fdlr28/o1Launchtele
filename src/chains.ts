export interface ChainInfo {
  id: number;
  name: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Public RPC used when RPC_URL_<id> is not set. Only where the endpoint is well known. */
  defaultRpc?: string;
  /** Block explorer base URL (no trailing slash), used for tx links. */
  explorer?: string;
  /**
   * Most a single transaction may cost in gas (gas limit x max fee per gas, in wei). Generous compared with a
   * launch (tens of times), but far below what a broken or hostile RPC could make the wallet burn.
   */
  maxGasCostWei: bigint;
}

/** Applies to chains that are not in the table below. */
export const DEFAULT_MAX_GAS_COST_WEI = 10n ** 18n;

/**
 * Chains supported by the o1 Launchpad public API (docs.o1.exchange/launchpad/api/introduction).
 * Public RPCs are rate limited: set RPC_URL_<chainId> to a private endpoint for real use.
 * Robinhood Chain and Arc have no default RPC on purpose; the bot only enables them when
 * RPC_URL_4663 / RPC_URL_5042 is configured.
 */
export const CHAINS: Record<number, ChainInfo> = {
  8453: {
    id: 8453,
    name: 'Base',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    defaultRpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    maxGasCostWei: 10n ** 16n, // 0.01 ETH
  },
  4663: {
    id: 4663,
    name: 'Robinhood Chain',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorer: 'https://rh-scan.com',
    maxGasCostWei: 10n ** 16n, // 0.01 ETH
  },
  143: {
    id: 143,
    name: 'Monad',
    nativeSymbol: 'MON',
    nativeDecimals: 18,
    defaultRpc: 'https://rpc.monad.xyz',
    maxGasCostWei: 20n * 10n ** 18n, // 20 MON
  },
  5042: {
    id: 5042,
    name: 'Arc',
    nativeSymbol: 'USDC',
    nativeDecimals: 18,
    maxGasCostWei: 2n * 10n ** 18n, // 2 USDC (Arc pays gas in USDC)
  },
  56: {
    id: 56,
    name: 'BSC',
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    defaultRpc: 'https://bsc-dataseed.binance.org',
    explorer: 'https://bscscan.com',
    maxGasCostWei: 5n * 10n ** 16n, // 0.05 BNB
  },
  196: {
    id: 196,
    name: 'X Layer',
    nativeSymbol: 'OKB',
    nativeDecimals: 18,
    defaultRpc: 'https://rpc.xlayer.tech',
    explorer: 'https://xlayerscan.com',
    maxGasCostWei: 5n * 10n ** 17n, // 0.5 OKB
  },
};

export const SUPPORTED_CHAIN_IDS = Object.keys(CHAINS).map(Number);

/**
 * Chains with stock-paired markets (Base, Robinhood, BSC, X Layer). The docs say Monad and Arc
 * "use market=standard only", so /config is queried with market=all only where stocks exist.
 */
export const STOCK_CHAIN_IDS: ReadonlySet<number> = new Set([8453, 4663, 56, 196]);

export function chainName(chainId: number): string {
  return CHAINS[chainId]?.name ?? `Chain ${chainId}`;
}

export function txUrl(chainId: number, hash: string, overrides: Record<number, string> = {}): string | null {
  const base = overrides[chainId] ?? CHAINS[chainId]?.explorer;
  return base ? `${base.replace(/\/+$/, '')}/tx/${hash}` : null;
}

export function addressUrl(chainId: number, address: string, overrides: Record<number, string> = {}): string | null {
  const base = overrides[chainId] ?? CHAINS[chainId]?.explorer;
  return base ? `${base.replace(/\/+$/, '')}/address/${address}` : null;
}
