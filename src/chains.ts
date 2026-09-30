export interface ChainInfo {
  id: number;
  name: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Public RPC used when RPC_URL_<id> is not set. Only where the endpoint is well known. */
  defaultRpc?: string;
  /** Block explorer base URL (no trailing slash), used for tx links. */
  explorer?: string;
}

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
  },
  4663: {
    id: 4663,
    name: 'Robinhood Chain',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorer: 'https://rh-scan.com',
  },
  143: {
    id: 143,
    name: 'Monad',
    nativeSymbol: 'MON',
    nativeDecimals: 18,
    defaultRpc: 'https://rpc.monad.xyz',
  },
  5042: {
    id: 5042,
    name: 'Arc',
    nativeSymbol: 'USDC',
    nativeDecimals: 18,
  },
  56: {
    id: 56,
    name: 'BSC',
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    defaultRpc: 'https://bsc-dataseed.binance.org',
    explorer: 'https://bscscan.com',
  },
  196: {
    id: 196,
    name: 'X Layer',
    nativeSymbol: 'OKB',
    nativeDecimals: 18,
    defaultRpc: 'https://rpc.xlayer.tech',
    explorer: 'https://xlayerscan.com',
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
