import { getAddress, isAddress, isHex, zeroAddress, type Address, type Hex } from 'viem';
import { UserFacingError } from '../errors.js';
import { sameAddress } from '../o1/swap.js';
import type { ContractSuite, TransactionRequest, TypedDataRequest } from '../o1/types.js';
import type { TypedDataPayload } from '../wallet/wallet.js';

/**
 * The bot signs with a hot wallet, so it never signs blindly what the API returns.
 *
 * The guard is role based rather than a flat allow-list:
 *  - only the contracts that a step of this kind must call may receive a non-approve call
 *    (the factory for a launch, the routers for a swap); Permit2, escrow, hook, ... never do
 *  - ERC-20 tokens (the fee token for a launch, the pair for a dev buy) may only receive `approve`, to a known
 *    spender, with an amount bounded PER TOKEN by what the owner reviewed. Permit2 is the one spender that may
 *    receive an unlimited allowance, because it can only spend what a separately signed and bounded permit allows
 *  - the whole list of steps is validated before the first one is sent: a bounded number of steps,
 *    the total native value bounded by what the user reviewed, and only the last step may be a call
 *  - a Permit2 permit is rebuilt from the validated fields, so what is signed is exactly what was checked
 *
 * Together these bound the worst case to the fee / dev buy amount the user reviewed, even though the
 * calldata of the factory and router calls themselves is opaque to us.
 *
 * Which factory and routers are "the right ones" still comes from the o1 API (/config); the launcher pins them
 * at Review and refuses to launch if they change, and Review shows them. Permit2 does NOT come from /config:
 * unlimited allowances only go to the canonical deployment (or one the owner listed in EXTRA_ALLOWED_TARGETS).
 */
export type PlanKind = 'launch' | 'swap';

/** Uniswap's Permit2: the same address on every chain it is deployed to. */
export const CANONICAL_PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

export interface Erc20Limit {
  /** Largest allowance an `approve` may grant to any spender other than Permit2. */
  maxApprove: bigint;
  /** Largest amount a Permit2 permit may cover. */
  maxPermit: bigint;
}

export interface GuardInput {
  chainId: number;
  from: Address;
  suite: ContractSuite;
  kind: PlanKind;
  /** The ERC-20 tokens this plan may touch, each with its own bounds. A native-only plan passes none. */
  erc20: ReadonlyArray<{ address: string } & Erc20Limit>;
  /** Native value all transactions of one plan together may carry. */
  maxTotalNativeValue: bigint;
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
  /** Lower-cased ERC-20 tokens: approve only, value 0, each with its own bounds. */
  erc20: Map<string, Erc20Limit>;
  /** Lower-cased Permit2 deployments that are trusted (swap plans only). Never callable. */
  permit2: Set<string>;
  maxTotalNativeValue: bigint;
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
  typeof value === 'string' && isAddress(value, { strict: false }) && value.toLowerCase() !== zeroAddress;

const lower = (value: string) => value.toLowerCase();

function addAll(target: Set<string>, values: Array<unknown>): void {
  for (const value of values) if (isRealAddress(value)) target.add(lower(value));
}

export function guardPolicyFor(input: GuardInput): GuardPolicy {
  const c = input.suite.contracts;
  const extras = new Set<string>();
  addAll(extras, [...(input.extraTargets ?? [])]);

  const callTargets = new Set<string>();
  const spenders = new Set<string>();
  if (input.kind === 'launch') {
    addAll(callTargets, [c.factory]);
    addAll(spenders, [c.factory]);
  } else {
    addAll(callTargets, [c.swapx_router, c.universal_router]);
    addAll(spenders, [c.swapx_router, c.universal_router]);
  }
  for (const extra of extras) {
    callTargets.add(extra);
    spenders.add(extra);
  }

  // Permit2 is only relevant for swaps. The canonical deployment is always trusted; the suite's own is trusted
  // only when it IS the canonical one or the owner vouched for it. It may be a spender, never a call target.
  const permit2 = new Set<string>();
  if (input.kind === 'swap') {
    permit2.add(CANONICAL_PERMIT2);
    if (isRealAddress(c.permit2) && extras.has(lower(c.permit2))) permit2.add(lower(c.permit2));
  }
  for (const address of permit2) {
    spenders.add(address);
    callTargets.delete(address);
  }

  const erc20 = new Map<string, Erc20Limit>();
  for (const token of input.erc20) {
    if (!isRealAddress(token.address)) continue;
    erc20.set(lower(token.address), { maxApprove: token.maxApprove, maxPermit: token.maxPermit });
  }

  return {
    chainId: input.chainId,
    from: input.from,
    kind: input.kind,
    callTargets,
    spenders,
    erc20,
    permit2,
    maxTotalNativeValue: input.maxTotalNativeValue,
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

  const target = lower(tx.to);
  const selector = lower(tx.data.slice(0, 10));

  const limit = policy.erc20.get(target);
  if (limit) {
    if (selector !== APPROVE_SELECTOR) fail('token ERC-20 hanya boleh menerima approve.');
    if (tx.data.length !== APPROVE_CALLDATA_LENGTH) fail('calldata approve tidak standar.');
    if (value !== 0n) fail('approve tidak boleh membawa value.');
    const spender = lower(`0x${tx.data.slice(34, 74)}`);
    const amount = BigInt(`0x${tx.data.slice(74)}`);
    if (!policy.spenders.has(spender)) fail(`spender approve ${spender} bukan kontrak yang diizinkan untuk langkah ini.`);
    if (!policy.permit2.has(spender) && amount > limit.maxApprove) {
      fail(`approve ${amount} melebihi batas ${limit.maxApprove} yang kamu setujui.`);
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

// ---------------------------------------------------------------------------------------------
// Permit2
// ---------------------------------------------------------------------------------------------

/** The Permit2 `PermitSingle` type map, exactly as the contract defines it (field order matters for the type hash). */
const PERMIT2_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
};

const typesKey = (types: Record<string, Array<{ name: string; type: string }>>): string =>
  JSON.stringify(
    Object.keys(types)
      .filter((name) => name !== 'EIP712Domain')
      .sort()
      .map((name) => [name, (types[name] ?? []).map((field) => [field.name, field.type])]),
  );

const PERMIT2_TYPES_KEY = typesKey(PERMIT2_TYPES);

/** A non-negative integer of at most `bits` bits, from a bigint, a safe integer or a plain decimal string only. */
function parseUint(value: unknown, bits: number, name: string): bigint {
  let n: bigint | undefined;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) n = BigInt(value);
  if (n === undefined) throw new UserFacingError(`Tanda tangan Permit2 ditolak demi keamanan: ${name} tidak valid.`);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new UserFacingError(`Tanda tangan Permit2 ditolak demi keamanan: ${name} di luar jangkauan.`);
  return n;
}

/**
 * A Permit2 permit may only authorise the reviewed token, a bounded amount and a router as spender.
 * Returns the payload REBUILT from the validated fields: that, and nothing the API sent, is what gets signed,
 * so the checker and the signer cannot disagree about what the message says.
 */
export function assertTypedDataAllowed(td: TypedDataRequest, policy: GuardPolicy): TypedDataPayload {
  const fail = (reason: string): never => {
    throw new UserFacingError(`Tanda tangan Permit2 ditolak demi keamanan: ${reason}`);
  };
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

  if (td.primaryType !== 'PermitSingle') fail(`tipe ${td.primaryType} tidak didukung.`);
  if (!isRecord(td.domain) || !isRecord(td.types) || !isRecord(td.message)) fail('bentuk data tidak valid.');

  const domain = td.domain as Record<string, unknown>;
  const stray = Object.keys(domain).filter((key) => !['name', 'chainId', 'verifyingContract'].includes(key));
  if (stray.length > 0) fail(`domain memuat field yang tidak dikenal (${stray.join(', ')}).`);
  if (domain.name !== 'Permit2') fail('domain bukan Permit2.');
  const domainChain =
    typeof domain.chainId === 'number' ? domain.chainId : typeof domain.chainId === 'string' && /^\d+$/.test(domain.chainId) ? Number(domain.chainId) : Number.NaN;
  if (domainChain !== policy.chainId) fail('chain pada domain tidak cocok.');
  const verifying = domain.verifyingContract;
  if (!isRealAddress(verifying) || !policy.permit2.has(lower(verifying))) {
    fail('kontrak Permit2 bukan yang dipercaya (Permit2 kanonis, atau yang kamu daftarkan di EXTRA_ALLOWED_TARGETS).');
  }
  if (typesKey(td.types) !== PERMIT2_TYPES_KEY) fail('struktur tipe permit tidak sama dengan Permit2.');

  const message = td.message as { spender?: unknown; sigDeadline?: unknown; details?: unknown };
  if (!isRealAddress(message.spender) || !policy.callTargets.has(lower(message.spender))) {
    fail('spender bukan router yang dikenal untuk swap ini.');
  }
  if (!isRecord(message.details)) fail('details permit tidak valid.');
  const details = message.details as Record<string, unknown>;
  const token = details.token;
  const limit = isRealAddress(token) ? policy.erc20.get(lower(token)) : undefined;
  if (!isRealAddress(token) || !limit) fail('token yang di-permit bukan pair yang dipilih.');

  const amount = parseUint(details.amount, 160, 'jumlah permit');
  if (amount > limit!.maxPermit) fail(`jumlah permit ${amount} melebihi batas ${limit!.maxPermit} yang kamu setujui.`);

  const now = BigInt(policy.nowSec());
  const expiration = parseUint(details.expiration, 48, 'expiration');
  if (expiration < now || expiration > now + BigInt(MAX_PERMIT_EXPIRATION_SEC)) fail('masa berlaku allowance permit di luar batas wajar.');
  const nonce = parseUint(details.nonce, 48, 'nonce');
  const sigDeadline = parseUint(message.sigDeadline, 256, 'sigDeadline');
  if (sigDeadline < now || sigDeadline > now + BigInt(MAX_PERMIT_SIG_DEADLINE_SEC)) fail('batas waktu tanda tangan permit di luar batas wajar.');

  return {
    domain: { name: 'Permit2', chainId: policy.chainId, verifyingContract: getAddress(verifying as string) },
    types: structuredClone(PERMIT2_TYPES),
    primaryType: 'PermitSingle',
    message: {
      details: { token: getAddress(token as string), amount, expiration, nonce },
      spender: getAddress(message.spender as string),
      sigDeadline,
    },
  };
}
