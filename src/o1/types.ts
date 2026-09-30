import type { Address, Hex } from 'viem';

/** Subset of the o1 Launchpad Public API types that this bot uses (see docs.o1.exchange/launchpad/api). */

export type Product = 'tax' | 'non-tax';
export type Route = 'standard' | 'rwa';

export interface ResponseMeta {
  request_id: string;
  generated_at: string;
  warnings: string[];
}

export interface ApiEnvelope<T> {
  data: T;
  meta: ResponseMeta;
}

export interface NativeCurrency {
  symbol: string;
  decimals: number;
}

export interface ChainConfiguration {
  chain_id: number;
  name: string;
  native_currency: NativeCurrency;
}

export interface ConfigurationCreationFee {
  amount_raw: string;
  currency: string;
  symbol: string;
  decimals: number;
}

export interface InclusiveTaxPolicy {
  format: 'inclusive';
  percentage_scale: string;
  rate_scale: string;
  tax_fee_bounds: {
    minimum_buy_tax_rate: string;
    maximum_buy_tax_rate: string;
    minimum_sell_tax_rate: string;
    maximum_sell_tax_rate: string;
  };
  protocol_fee_configuration: {
    protocol_tax_share: string;
    minimum_protocol_fee_rate: string;
    maximum_protocol_fee_rate: string;
    protocol_fee_recipient: Address;
  };
  anti_snipe_configuration: {
    start_total_fee_rate: string;
    window_seconds: number;
  };
  minimum_dividend_holding_requirement_raw: string;
}

export interface SuiteContracts {
  factory: Address;
  hook: Address;
  fee_escrow: Address;
  vesting_vault?: Address;
  announcement_registry: Address;
  pool_manager: Address;
  state_view: Address;
  quoter: Address;
  universal_router?: Address;
  swapx_router?: Address;
  permit2?: Address;
}

export interface ContractSuite {
  id: string;
  version: string;
  chain_id: number;
  route: Route;
  supported_routes: Route[];
  active_for_creation: boolean;
  creation_available: boolean;
  token_mode: 'b20' | 'erc20';
  launch_product?: Product;
  tax_format?: 'pre-inclusive' | 'inclusive';
  tax_policy?: InclusiveTaxPolicy | Record<string, unknown>;
  config_version?: string;
  launch_supply_raw?: string;
  launch_creation_enabled?: boolean;
  launch_buy_adapter_address?: Address;
  creation_fee?: ConfigurationCreationFee;
  contracts: SuiteContracts;
}

export type AssetType = 'native' | 'stablecoin' | 'wrapped_crypto' | 'crypto_token' | 'tokenized_security';

export interface QuoteConfiguration {
  address: Address;
  symbol: string;
  name?: string;
  decimals: number;
  asset_type?: AssetType | null;
  route: Route;
  suite_id: string;
  registered: boolean;
  selectable: boolean;
  quote_revision?: string;
  creation_fee?: ConfigurationCreationFee;
}

export interface Configuration {
  chain?: ChainConfiguration;
  supported_chain_ids?: number[];
  suites?: ContractSuite[];
  quotes?: QuoteConfiguration[];
  as_of_block?: string;
}

export interface PlanIssue {
  code: string;
  severity: 'blocking' | 'action_required' | 'warning';
  detail?: string;
  asset?: Address;
  spender?: Address;
  actual_raw?: string;
  required_raw?: string;
  remediation_step_id?: string;
}

export interface TransactionRequest {
  chain_id: number;
  from: Address;
  to: Address;
  data: Hex;
  value: string;
}

export interface Simulation {
  status: 'succeeded' | 'not_run';
  block_number?: string;
}

export interface TypedDataRequest {
  domain: { name: string; chainId: number; verifyingContract: Address; [key: string]: unknown };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface TransactionStepTx {
  id: string;
  kind: 'transaction';
  label: string;
  depends_on: string[];
  transaction: TransactionRequest;
  simulation?: Simulation;
}

export interface TransactionStepTypedData {
  id: string;
  kind: 'typed_data';
  label: string;
  depends_on: string[];
  typed_data: TypedDataRequest;
  simulation?: Simulation;
}

export type TransactionStep = TransactionStepTx | TransactionStepTypedData;

export interface TransactionPlan {
  chain_id: number;
  actor: Address;
  prepared_at: string;
  expires_at: string;
  observed_block: string;
  issues: PlanIssue[];
  steps: TransactionStep[];
}

export interface LaunchPrepareResult extends TransactionPlan {
  predicted_token_address: Address;
  suite_id: string;
  metadata_uri: string;
  image_url: string | null;
  creation_fee?: { amount_raw: string; currency_address: Address; decimals?: number; symbol?: string };
  review?: Record<string, unknown>;
}

export interface MetadataPair {
  key: string;
  value: string;
}

export interface InclusiveTaxLaunchSettings {
  format: 'inclusive';
  buy_tax_rate: string;
  sell_tax_rate: string;
  creator_allocation_share: string;
  burn_allocation_share: string;
  dividend_allocation_share: string;
  integrator_allocation_share: string;
  minimum_dividend_holding_raw: string;
  creator_fee_recipient: Address;
  integrator_fee_recipient?: Address;
  anti_snipe_enabled: boolean;
}

export interface LaunchPrepareRequest {
  chain_id: number;
  creator: Address;
  market: Route;
  launch_product: Product;
  tax?: InclusiveTaxLaunchSettings;
  quote_address: Address;
  token: {
    name: string;
    symbol: string;
    description: string;
    image_base64: string;
    image_type: string;
    website: string;
    x: string;
    telegram: string;
    editable_metadata: boolean;
    extra_metadata: MetadataPair[];
  };
}

export interface SwapQuoteRequest {
  chain_id: number;
  wallet: Address;
  token_address: Address;
  side: 'buy' | 'sell';
  amount_in_raw: string;
  slippage_bps: number;
  referrer?: Address;
  comment?: string;
}

/**
 * The swap responses are only partially specified in the public docs, so they are parsed
 * tolerantly (see swap.ts) instead of being trusted to have one exact shape.
 */
export interface SwapQuoteResult {
  quote_id: string;
  issues?: PlanIssue[];
  steps?: TransactionStep[];
  [key: string]: unknown;
}

export interface SwapPrepareRequest {
  quote_id: string;
  wallet: Address;
  permit2_signature?: Hex;
}

export interface SwapPrepareResult {
  steps?: TransactionStep[];
  issues?: PlanIssue[];
  expires_at?: string;
  [key: string]: unknown;
}

export interface Problem {
  type?: string;
  title?: string;
  status: number;
  code: string;
  detail?: string;
  action?: string;
  request_id?: string;
  asset?: string;
  actual_raw?: string;
  required_raw?: string;
  [key: string]: unknown;
}
