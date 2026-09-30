import { isAddress, isHex, zeroAddress, type Address, type Hex } from 'viem';
import { UserFacingError } from '../errors.js';
import { sameAddress } from '../o1/swap.js';
import type { ContractSuite, TransactionRequest, TypedDataRequest } from '../o1/types.js';

/**
 * The bot signs with a hot wallet, so it never signs blindly what the API returns.
 *
 * The guard is role based rather than a flat allow-list:
 *  - only the contracts that a step of this kind must call may receive a non-approve call
 *    (the factory for a launch, the routers for a swap); Permit2, escrow, hook, ... never do
 *  - ERC-20 tokens (the pair, or the fee token) may only receive `approve`, to a known spender,
 *    with a bounded amount (Permit2 is the one spender that may receive an unlimited allowance,
 *    because it can only spend what a separately signed and bounded permit allows)
 *  - the whole list of steps is validated before the first one is sent: a bounded number of steps,
 *    the total native value bounded by what the user reviewed, and only the final step may be a call
 *
 * Together these bound the worst case to the fee / dev buy amount the user reviewed, even though the
 * calldata of the factory and router calls themselves is opaque to us.
 */
export type PlanKind = 'launch' | 'swap';

export interface GuardInput {
  chainId: number;
  from: Address;
  suite: ContractSuite;
  kind: PlanKind;
  quoteAddress: Address;
  /** ERC-20 creation fee token (leave undefined for a native fee). */
  feeCurrency?: string;
  /** Native value all transactions of one plan together may carry. */
  maxTotalNativeValue: bigint;
  /** Largest allowance an ERC-20 `approve` may grant to any spender other than Permit2. */
  maxApproveAmount: bigint;
  /** Largest amount a Permit2 permit may cover. */
  maxPermitAmount: bigint;
  /** Extra contracts the owner explicitly trusts (EXTRA_ALLOWED_TARGETS): callable and usable as spender. */
  extraTargets?: readonly string[];
  nowSec?: () => number;
}

export interface GuardPolicy {
  chainId: number;
  from: Address;
  kind: PlanKind;
  /** Lower-cased contracts that may receive a non-approve call. */
  callTargets: Set<string>;
  /** Lower-cased contracts that may be granted an allowance (approve spender / permit spender). */
  spenders: Set<string>;
  /** Lower-cased ERC-20 tokens: approve only, value 0. */
  erc20Targets: Set<string>;
  permit2?: string;
  maxTotalNativeValue: bigint;
  maxApproveAmount: bigint;
  maxPermitAmount: bigint;
  nowSec: () => number;
}

const APPROVE_SELECTOR = '0x095ea7b3';
/** 0x + 4-byte selector + two 32-byte words. */
const APPROVE_CALLDATA_LENGTH = 2 + 8 + 64 + 64;

/** A plan needs at most an approval or two plus the final call. */
export const MAX_PLAN_STEPS = 4;
/** How long a Permit2 allowance may stay valid (Uniswap's own default is 30 days) and its signature may be used. */
export const MAX_PERMIT_EXPIRATION_SEC = 31 * 24 * 3600;
export const MAX_PERMIT_SIG_DEADLINE_SEC = 24 * 3600;

const isRealAddress = (value: unknown): value is Address =>
  typeof value === 'string' && isAddress(value) && value.toLowerCase() !== zeroAddress;

function addAll(target: Set<string>, values: Array<unknown>): void {
  for (const value of values) if (isRealAddress(value)) target.add(value.toLowerCase());
}

export function guardPolicyFor(input: GuardInput): GuardPolicy {
  const c = input.suite.contracts;
  const extras = (input.extraTargets ?? []).filter(isRealAddress);

  const callTargets = new Set<string>();
  const spenders = new Set<string>();
  if (input.kind === 'launch') {
    addAll(callTargets, [c.factory]);
    addAll(spenders, [c.factory]);
  } else {
    addAll(callTargets, [c.swapx_router, c.universal_router]);
    addAll(spenders, [c.swapx_router, c.universal_router, c.permit2]);
  }
  addAll(callTargets, extras);
  addAll(spenders, extras);

  const erc20Targets = new Set<string>();
  addAll(erc20Targets, [input.quoteAddress, input.feeCurrency]);

  return {
    chainId: input.chainId,
    from: input.from,
    kind: input.kind,
    callTargets,
    spenders,
    erc20Targets,
    permit2: isRealAddress(c.permit2) ? c.permit2.toLowerCase() : undefined,
    maxTotalNativeValue: input.maxTotalNativeValue,
    maxApproveAmount: input.maxApproveAmount,
    maxPermitAmount: input.maxPermitAmount,
    nowSec: input.nowSec ?? (() => Math.floor(Date.now() / 1000)),
  };
}

export interface SafeTx {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface CheckedTx extends SafeTx {
  kind: 'approve' | 'call';
}

const refuse = (label: string, reason: string): never => {
  throw new UserFacingError(`Transaksi "${label}" ditolak demi keamanan: ${reason}`);
};

/** Validates one transaction on its own. Throws UserFacingError when it must not be signed. */
export function checkTx(tx: TransactionRequest, policy: GuardPolicy, label: string): CheckedTx {
  const fail = (reason: string): never => refuse(label, reason);

  if (tx.chain_id !== policy.chainId) fail(`chain ${tx.chain_id} bukan chain yang dipilih (${policy.chainId}).`);
  if (!sameAddress(tx.from, policy.from)) fail('pengirim bukan wallet bot.');
  if (!isRealAddress(tx.to)) fail('alamat tujuan tidak valid atau alamat nol.');
  if (!isHex(tx.data) || (tx.data.length - 2) % 2 !== 0) fail('calldata tidak valid.');
  if (typeof tx.value !== 'string' || !/^\d+$/.test(tx.value)) fail('nilai (value) tidak valid.');

  const value = BigInt(tx.value);
  if (value > policy.maxTotalNativeValue) {
    fail(`value ${value} melebihi batas yang kamu setujui (${policy.maxTotalNativeValue}).`);
  }

  const target = tx.to.toLowerCase();
  const selector = tx.data.slice(0, 10).toLowerCase();

  if (policy.erc20Targets.has(target)) {
    if (selector !== APPROVE_SELECTOR) fail('token ERC-20 hanya boleh menerima approve.');
    if (tx.data.length !== APPROVE_CALLDATA_LENGTH) fail('calldata approve tidak standar.');
    if (value !== 0n) fail('approve tidak boleh membawa value.');
    const spender = `0x${tx.data.slice(34, 74)}`.toLowerCase();
    const amount = BigInt(`0x${tx.data.slice(74)}`);
    if (!policy.spenders.has(spender)) fail(`spender approve ${spender} bukan kontrak yang diizinkan untuk langkah ini.`);
    if (spender !== policy.permit2 && amount > policy.maxApproveAmount) {
      fail(`approve ${amount} melebihi batas ${policy.maxApproveAmount} yang kamu setujui.`);
    }
    return { to: tx.to, data: tx.data, value, kind: 'approve' };
  }

  if (policy.callTargets.has(target)) return { to: tx.to, data: tx.data, value, kind: 'call' };

  return fail(`tujuan ${tx.to} bukan kontrak yang boleh dipanggil pada langkah ${policy.kind === 'launch' ? 'launch' : 'swap'} ini.`);
}

export interface PlanTx {
  id: string;
  transaction: TransactionRequest;
}

/**
 * Validates a whole list of steps BEFORE anything is signed, so a later bad step cannot be discovered
 * after earlier ones were already broadcast.
 *  - finalCall = true : approvals first, then exactly one call (a launch or a swap)
 *  - finalCall = false: approvals only (e.g. the prerequisites returned by a swap quote)
 */
export function assertPlanAllowed(steps: PlanTx[], policy: GuardPolicy, opts: { finalCall: boolean }): CheckedTx[] {
  if (steps.length === 0) return refuse('plan', 'plan kosong.');
  if (steps.length > MAX_PLAN_STEPS) refuse('plan', `terlalu banyak langkah (${steps.length}, maksimal ${MAX_PLAN_STEPS}).`);

  const checked = steps.map((step) => checkTx(step.transaction, policy, step.id));

  const total = checked.reduce((sum, tx) => sum + tx.value, 0n);
  if (total > policy.maxTotalNativeValue) {
    refuse('plan', `total value semua langkah ${total} melebihi batas yang kamu setujui (${policy.maxTotalNativeValue}).`);
  }

  checked.forEach((tx, index) => {
    const id = steps[index]?.id ?? String(index);
    const isLast = index === checked.length - 1;
    if (tx.kind === 'call' && !(isLast && opts.finalCall)) {
      refuse(id, opts.finalCall ? 'hanya langkah terakhir yang boleh berupa panggilan; langkah sebelumnya harus approve.' : 'hanya approve yang diizinkan pada tahap ini.');
    }
  });
  if (opts.finalCall && checked[checked.length - 1]?.kind !== 'call') {
    refuse('plan', 'langkah terakhir harus berupa panggilan ke kontrak o1, bukan approve.');
  }
  return checked;
}

/** Permit2 signatures may only authorise the reviewed pair, a bounded amount and a router as spender. */
export function assertTypedDataAllowed(td: TypedDataRequest, policy: GuardPolicy): void {
  const fail = (reason: string): never => {
    throw new UserFacingError(`Tanda tangan Permit2 ditolak demi keamanan: ${reason}`);
  };
  if (td.primaryType !== 'PermitSingle') fail(`tipe ${td.primaryType} tidak didukung.`);
  if (td.domain.name !== 'Permit2') fail('domain bukan Permit2.');
  if (Number(td.domain.chainId) !== policy.chainId) fail('chain pada domain tidak cocok.');
  if (!policy.permit2 || !sameAddress(td.domain.verifyingContract, policy.permit2)) {
    fail('kontrak Permit2 tidak cocok dengan konfigurasi o1.');
  }

  const message = td.message as {
    spender?: string;
    sigDeadline?: string | number;
    details?: { token?: string; amount?: string | number; expiration?: string | number };
  };
  if (!message.spender || !policy.callTargets.has(message.spender.toLowerCase())) {
    fail('spender bukan router yang dikenal untuk swap ini.');
  }
  const token = message.details?.token;
  if (!token || !policy.erc20Targets.has(token.toLowerCase())) fail('token yang di-permit bukan pair yang dipilih.');

  const toBig = (value: unknown, name: string): bigint => {
    try {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return BigInt(value);
    } catch {
      /* fall through */
    }
    return fail(`${name} tidak valid.`);
  };
  const amount = toBig(message.details?.amount, 'jumlah permit');
  if (amount > policy.maxPermitAmount) fail(`jumlah permit ${amount} melebihi batas ${policy.maxPermitAmount} yang kamu setujui.`);

  const now = BigInt(policy.nowSec());
  const expiration = toBig(message.details?.expiration, 'expiration');
  if (expiration < now || expiration > now + BigInt(MAX_PERMIT_EXPIRATION_SEC)) fail('masa berlaku allowance permit di luar batas wajar.');
  const sigDeadline = toBig(message.sigDeadline, 'sigDeadline');
  if (sigDeadline < now || sigDeadline > now + BigInt(MAX_PERMIT_SIG_DEADLINE_SEC)) fail('batas waktu tanda tangan permit di luar batas wajar.');
}
