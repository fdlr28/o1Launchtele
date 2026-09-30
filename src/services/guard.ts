import { isAddress, isHex, zeroAddress, type Address, type Hex } from 'viem';
import { UserFacingError } from '../errors.js';
import { sameAddress } from '../o1/swap.js';
import type { ContractSuite, TransactionRequest, TypedDataRequest } from '../o1/types.js';

/**
 * The bot signs with a hot wallet, so it never signs blindly what the API returns.
 * Every transaction must be on the expected chain, from our wallet, sent to a contract we know
 * from /config (or the quote asset for approvals) and must not carry more native value than the
 * user reviewed. ERC-20 targets may only ever receive `approve` calls.
 */
export interface GuardPolicy {
  chainId: number;
  from: Address;
  /** Lower-cased contract addresses that transactions may target. */
  allowedTargets: Set<string>;
  /** Addresses that are ERC-20 tokens (approve only, value 0). */
  erc20Targets: Set<string>;
  /** Highest native `value` that a single transaction may carry. */
  maxNativeValue: bigint;
  permit2?: Address;
  /** Assets that a Permit2 signature may cover. */
  permitTokens: Set<string>;
  /** When false the target allow-list is skipped (escape hatch, see STRICT_TARGETS in .env). */
  strict: boolean;
}

const APPROVE_SELECTOR = '0x095ea7b3';

export interface GuardInput {
  chainId: number;
  from: Address;
  suite: ContractSuite;
  quoteAddress: Address;
  feeCurrency?: string;
  maxNativeValue: bigint;
  strict: boolean;
}

export function guardPolicyFor(input: GuardInput): GuardPolicy {
  const allowed = new Set<string>();
  for (const value of Object.values(input.suite.contracts)) {
    if (typeof value === 'string' && isAddress(value)) allowed.add(value.toLowerCase());
  }
  if (input.suite.launch_buy_adapter_address && input.suite.launch_buy_adapter_address !== zeroAddress) {
    allowed.add(input.suite.launch_buy_adapter_address.toLowerCase());
  }

  const erc20 = new Set<string>();
  for (const token of [input.quoteAddress, input.feeCurrency]) {
    if (token && isAddress(token) && token.toLowerCase() !== zeroAddress) {
      erc20.add(token.toLowerCase());
      allowed.add(token.toLowerCase());
    }
  }

  return {
    chainId: input.chainId,
    from: input.from,
    allowedTargets: allowed,
    erc20Targets: erc20,
    maxNativeValue: input.maxNativeValue,
    permit2: input.suite.contracts.permit2,
    permitTokens: new Set(erc20),
    strict: input.strict,
  };
}

export interface SafeTx {
  to: Address;
  data: Hex;
  value: bigint;
}

export function assertTxAllowed(tx: TransactionRequest, policy: GuardPolicy, label: string): SafeTx {
  const fail = (reason: string): never => {
    throw new UserFacingError(`Transaksi "${label}" ditolak demi keamanan: ${reason}`);
  };

  if (tx.chain_id !== policy.chainId) fail(`chain ${tx.chain_id} bukan chain yang dipilih (${policy.chainId}).`);
  if (!sameAddress(tx.from, policy.from)) fail('pengirim bukan wallet bot.');
  if (!isAddress(tx.to)) fail('alamat tujuan tidak valid.');
  if (!isHex(tx.data)) fail('calldata tidak valid.');
  if (typeof tx.value !== 'string' || !/^\d+$/.test(tx.value)) fail('nilai (value) tidak valid.');

  const value = BigInt(tx.value);
  if (value > policy.maxNativeValue) {
    fail(`value ${value} melebihi batas yang kamu setujui (${policy.maxNativeValue}).`);
  }

  const target = tx.to.toLowerCase();
  if (policy.strict && !policy.allowedTargets.has(target)) {
    fail(`tujuan ${tx.to} bukan kontrak o1 yang dikenal untuk chain ini.`);
  }

  const selector = tx.data.slice(0, 10).toLowerCase();
  if (policy.erc20Targets.has(target)) {
    if (selector !== APPROVE_SELECTOR) fail('token ERC-20 hanya boleh menerima approve.');
    if (value !== 0n) fail('approve tidak boleh membawa value.');
  }
  if (selector === APPROVE_SELECTOR && tx.data.length >= 74) {
    const spender = `0x${tx.data.slice(34, 74)}`;
    if (policy.strict && !policy.allowedTargets.has(spender.toLowerCase())) {
      fail(`spender approve ${spender} bukan kontrak o1 yang dikenal.`);
    }
  }

  return { to: tx.to, data: tx.data, value };
}

export function assertTypedDataAllowed(td: TypedDataRequest, policy: GuardPolicy): void {
  const fail = (reason: string): never => {
    throw new UserFacingError(`Tanda tangan Permit2 ditolak demi keamanan: ${reason}`);
  };
  if (td.primaryType !== 'PermitSingle') fail(`tipe ${td.primaryType} tidak didukung.`);
  if (Number(td.domain.chainId) !== policy.chainId) fail('chain pada domain tidak cocok.');
  if (policy.strict && policy.permit2 && !sameAddress(td.domain.verifyingContract, policy.permit2)) {
    fail('kontrak Permit2 tidak cocok dengan konfigurasi o1.');
  }
  const message = td.message as { spender?: string; details?: { token?: string } };
  if (policy.strict && (!message.spender || !policy.allowedTargets.has(message.spender.toLowerCase()))) {
    fail('spender bukan kontrak o1 yang dikenal.');
  }
  const token = message.details?.token;
  if (!token || !policy.permitTokens.has(token.toLowerCase())) fail('token yang di-permit bukan pair yang dipilih.');
}
