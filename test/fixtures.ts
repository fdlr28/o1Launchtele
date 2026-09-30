import type { Address } from 'viem';
import type {
  Configuration,
  ContractSuite,
  InclusiveTaxPolicy,
  Product,
  QuoteConfiguration,
} from '../src/o1/types.js';

/** Deterministic, valid (digits-only, so checksum-safe) test addresses. */
export const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address;

export const WALLET = addr(0x1111);
export const RECIPIENT = addr(0x3333);
export const FACTORY = addr(0x2000);
export const HOOK = addr(0x2001);
export const ROUTER = addr(0x2002);
/** The canonical Permit2 deployment (the guard trusts this address, not whatever /config says). */
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const PROTOCOL = addr(0x4444);
export const USDC = addr(0x5555);
export const AAPL = addr(0x6666);
export const TOKEN = addr(0x7701);
export const ZERO = addr(0);

export const TOKENS_10K = '10000000000000000000000';

export function taxPolicy(overrides: Partial<InclusiveTaxPolicy> = {}): InclusiveTaxPolicy {
  return {
    format: 'inclusive',
    percentage_scale: '100000000',
    rate_scale: '1000000000000000000000000',
    tax_fee_bounds: {
      minimum_buy_tax_rate: '1000000',
      maximum_buy_tax_rate: '10000000',
      minimum_sell_tax_rate: '1000000',
      maximum_sell_tax_rate: '10000000',
    },
    protocol_fee_configuration: {
      protocol_tax_share: '10000000',
      minimum_protocol_fee_rate: '500000',
      maximum_protocol_fee_rate: '1000000',
      protocol_fee_recipient: PROTOCOL,
    },
    anti_snipe_configuration: { start_total_fee_rate: '99000000', window_seconds: 20 },
    minimum_dividend_holding_requirement_raw: TOKENS_10K,
    ...overrides,
  };
}

export function suite(product: Product, chainId = 8453): ContractSuite {
  return {
    id: product === 'tax' ? `test-${chainId}-tax` : `test-${chainId}-std`,
    version: 'v2',
    chain_id: chainId,
    route: 'standard',
    supported_routes: ['standard', 'rwa'],
    active_for_creation: true,
    creation_available: true,
    token_mode: 'erc20',
    launch_product: product,
    ...(product === 'tax' ? { tax_format: 'inclusive' as const, tax_policy: taxPolicy() } : {}),
    config_version: '7',
    launch_supply_raw: '1000000000000000000000000000',
    launch_creation_enabled: true,
    creation_fee: { amount_raw: '1000000000000000', currency: ZERO, symbol: 'ETH', decimals: 18 },
    contracts: {
      factory: FACTORY,
      hook: HOOK,
      fee_escrow: addr(0x2006),
      announcement_registry: addr(0x2007),
      pool_manager: addr(0x2008),
      state_view: addr(0x2009),
      quoter: addr(0x200a),
      swapx_router: ROUTER,
      permit2: PERMIT2,
    },
  };
}

export function quote(
  suiteId: string,
  address: Address,
  symbol: string,
  overrides: Partial<QuoteConfiguration> = {},
): QuoteConfiguration {
  return {
    address,
    symbol,
    decimals: 18,
    route: 'standard',
    suite_id: suiteId,
    registered: true,
    selectable: true,
    ...overrides,
  };
}

export function configFor(product: Product, chainId = 8453): Configuration {
  const s = suite(product, chainId);
  return {
    chain: { chain_id: chainId, name: 'Base', native_currency: { symbol: 'ETH', decimals: 18 } },
    suites: [s],
    quotes: [
      quote(s.id, ZERO, 'ETH', { asset_type: 'native' }),
      quote(s.id, USDC, 'USDC', { asset_type: 'stablecoin', decimals: 6 }),
      quote(s.id, AAPL, 'AAPL', { asset_type: 'tokenized_security', route: 'rwa', decimals: 8 }),
    ],
    as_of_block: '123',
  };
}
