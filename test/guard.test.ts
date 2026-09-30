import { encodeFunctionData, erc20Abi, maxUint160, maxUint256, parseAbi, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import { MAX_PLAN_STEPS, assertPlanAllowed, assertTypedDataAllowed, checkTx, guardPolicyFor, type GuardInput } from '../src/services/guard.js';
import type { ContractSuite, TransactionRequest, TypedDataRequest } from '../src/o1/types.js';
import { FACTORY, HOOK, PERMIT2, ROUTER, USDC, WALLET, ZERO, addr, suite } from './fixtures.js';

const FEE = 1_000_000_000_000_000n; // reviewed creation fee (native)
const AMOUNT = 5_000_000n; // reviewed dev buy amount (5 USDC)
const NOW = 1_800_000_000;
const ATTACKER = addr(0xbad);

const permit2Abi = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);

function launchPolicy(overrides: Partial<GuardInput> = {}) {
  return guardPolicyFor({
    chainId: 8453, from: WALLET, suite: suite('tax'), kind: 'launch', quoteAddress: ZERO,
    maxTotalNativeValue: FEE, maxApproveAmount: 0n, maxPermitAmount: 0n, nowSec: () => NOW, ...overrides,
  });
}

function swapPolicy(overrides: Partial<GuardInput> = {}) {
  return guardPolicyFor({
    chainId: 8453, from: WALLET, suite: suite('tax'), kind: 'swap', quoteAddress: USDC,
    maxTotalNativeValue: 0n, maxApproveAmount: AMOUNT, maxPermitAmount: AMOUNT, nowSec: () => NOW, ...overrides,
  });
}

const tx = (overrides: Partial<TransactionRequest> = {}): TransactionRequest => ({
  chain_id: 8453, from: WALLET, to: FACTORY, data: '0xdeadbeef', value: FEE.toString(), ...overrides,
});
const approve = (spender: Address, amount = 1n) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
const transfer = (to: Address) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, 1n] });
const approveTx = (token: Address, spender: Address, amount = 1n): TransactionRequest => ({ ...tx({ to: token, value: '0' }), data: approve(spender, amount) });
const refused = /ditolak demi keamanan/;

describe('checkTx: a launch step', () => {
  it('accepts the launch call to the factory, unchanged, up to the reviewed fee', () => {
    expect(checkTx(tx(), launchPolicy(), 'launch')).toEqual({ to: FACTORY, data: '0xdeadbeef', value: FEE, kind: 'call' });
    expect(checkTx(tx({ value: '0' }), launchPolicy(), 'x').value).toBe(0n);
  });

  it('rejects more value than reviewed, the wrong chain, a foreign sender and malformed fields', () => {
    expect(() => checkTx(tx({ value: (FEE + 1n).toString() }), launchPolicy(), 'launch')).toThrow(/melebihi/);
    expect(() => checkTx(tx({ chain_id: 1 }), launchPolicy(), 'x')).toThrow(/chain/);
    expect(() => checkTx(tx({ from: ATTACKER }), launchPolicy(), 'x')).toThrow(/pengirim/);
    expect(() => checkTx(tx({ to: 'nope' as Address }), launchPolicy(), 'x')).toThrow(UserFacingError);
    expect(() => checkTx(tx({ data: 'zz' as never }), launchPolicy(), 'x')).toThrow(/calldata/);
    expect(() => checkTx(tx({ value: '-1' }), launchPolicy(), 'x')).toThrow(/value/);
    expect(() => checkTx(tx({ value: '1.5' }), launchPolicy(), 'x')).toThrow(/value/);
  });

  it('rejects odd-length hex: viem would left-pad it, so the signed bytes would differ from the checked bytes', () => {
    expect(() => checkTx(tx({ data: '0xabc' }), launchPolicy(), 'x')).toThrow(/calldata/);
  });

  it('only the factory may be called; every other o1 contract is refused, including the router', () => {
    const c = suite('tax').contracts;
    for (const target of [ROUTER, PERMIT2, HOOK, c.fee_escrow, c.pool_manager, c.state_view, c.quoter, c.announcement_registry, ATTACKER]) {
      expect(() => checkTx(tx({ to: target }), launchPolicy(), 'x'), target).toThrow(refused);
    }
  });

  it('never accepts the zero address, even if /config lists it as a contract', () => {
    const broken: ContractSuite = { ...suite('tax'), contracts: { ...suite('tax').contracts, factory: ZERO } };
    expect(() => checkTx(tx({ to: ZERO }), launchPolicy({ suite: broken }), 'x')).toThrow(refused);
  });

  it('ERC-20 fee token: approve to the factory up to the fee, nothing else', () => {
    const p = launchPolicy({ feeCurrency: USDC, maxTotalNativeValue: 0n, maxApproveAmount: 5n });
    expect(checkTx(approveTx(USDC, FACTORY, 5n), p, 'approve').kind).toBe('approve');
    expect(() => checkTx(approveTx(USDC, FACTORY, 6n), p, 'approve')).toThrow(/melebihi batas/);
    expect(() => checkTx(approveTx(USDC, FACTORY, maxUint256), p, 'approve')).toThrow(/melebihi batas/);
    expect(() => checkTx(approveTx(USDC, ATTACKER), p, 'approve')).toThrow(/spender/);
    expect(() => checkTx(approveTx(USDC, ROUTER), p, 'approve')).toThrow(/spender/); // not a launch spender
    expect(() => checkTx({ ...tx({ to: USDC, value: '0' }), data: transfer(ATTACKER) }, p, 'x')).toThrow(/hanya boleh menerima approve/);
    expect(() => checkTx({ ...approveTx(USDC, FACTORY), value: '1' }, launchPolicy({ feeCurrency: USDC, maxTotalNativeValue: 10n, maxApproveAmount: 5n }), 'x')).toThrow(/value/);
    // trailing bytes after a well-formed approve are not standard calldata
    expect(() => checkTx({ ...approveTx(USDC, FACTORY), data: `${approve(FACTORY)}00` }, p, 'x')).toThrow(/tidak standar/);
  });
});

describe('checkTx: a swap step', () => {
  it('accepts a router call with native value up to the reviewed amount', () => {
    const p = swapPolicy({ quoteAddress: ZERO, maxTotalNativeValue: 50n });
    expect(checkTx(tx({ to: ROUTER, value: '50', data: '0x12345678' }), p, 'swap').kind).toBe('call');
    expect(() => checkTx(tx({ to: ROUTER, value: '51' }), p, 'swap')).toThrow(/melebihi/);
  });

  it('refuses the factory and every non-router o1 contract as a call target', () => {
    for (const target of [FACTORY, HOOK, PERMIT2, ATTACKER]) expect(() => checkTx(tx({ to: target, value: '0' }), swapPolicy(), 'x'), target).toThrow(refused);
  });

  it('refuses arbitrary calls to Permit2, such as granting a Permit2 allowance to an attacker (review finding)', () => {
    const grantToAttacker = encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [USDC, ATTACKER, maxUint160, 2 ** 40] });
    expect(grantToAttacker.startsWith('0x87517c45')).toBe(true);
    expect(() => checkTx(tx({ to: PERMIT2, value: '0', data: grantToAttacker }), swapPolicy(), 'x')).toThrow(refused);
    expect(() => checkTx(tx({ to: PERMIT2, value: '0', data: '0x00' }), swapPolicy(), 'x')).toThrow(refused);
  });

  it('allows an unlimited ERC-20 allowance to Permit2 only; other spenders are capped at the reviewed amount', () => {
    const p = swapPolicy();
    expect(checkTx(approveTx(USDC, PERMIT2, maxUint256), p, 'a').kind).toBe('approve');
    expect(checkTx(approveTx(USDC, ROUTER, AMOUNT), p, 'a').kind).toBe('approve');
    expect(() => checkTx(approveTx(USDC, ROUTER, AMOUNT + 1n), p, 'a')).toThrow(/melebihi batas/);
    expect(() => checkTx(approveTx(USDC, ROUTER, maxUint256), p, 'a')).toThrow(/melebihi batas/); // review finding
    expect(() => checkTx(approveTx(USDC, ATTACKER), p, 'a')).toThrow(/spender/);
    expect(() => checkTx(approveTx(USDC, FACTORY), p, 'a')).toThrow(/spender/); // not a swap spender
  });

  it('refuses approve on a token that is not the reviewed pair', () => {
    expect(() => checkTx(approveTx(addr(0x9999), ROUTER), swapPolicy(), 'a')).toThrow(refused);
  });
});

describe('assertPlanAllowed: the whole plan is judged before anything is sent', () => {
  const step = (id: string, transaction: TransactionRequest) => ({ id, transaction });
  const launch = () => step('launch', tx({ value: FEE.toString() }));

  it('accepts approvals followed by exactly one final call', () => {
    const p = launchPolicy({ feeCurrency: USDC, maxTotalNativeValue: FEE, maxApproveAmount: 5n });
    const checked = assertPlanAllowed([step('approve', approveTx(USDC, FACTORY, 5n)), launch()], p, { finalCall: true });
    expect(checked.map((c) => c.kind)).toEqual(['approve', 'call']);
    expect(assertPlanAllowed([launch()], launchPolicy(), { finalCall: true })).toHaveLength(1);
  });

  it('refuses many steps that each look fine on their own (review finding: 6 x fee)', () => {
    const many = Array.from({ length: 6 }, (_, i) => step(`s${i}`, tx({ value: FEE.toString() })));
    expect(() => assertPlanAllowed(many, launchPolicy(), { finalCall: true })).toThrow(/terlalu banyak langkah/);
    expect(MAX_PLAN_STEPS).toBeLessThan(6);
  });

  it('refuses two calls (only the last step may be a call) and a total value above the reviewed amount', () => {
    const two = [step('a', tx({ value: FEE.toString() })), step('b', tx({ value: FEE.toString() }))];
    expect(() => assertPlanAllowed(two, launchPolicy({ maxTotalNativeValue: FEE * 2n }), { finalCall: true })).toThrow(/hanya langkah terakhir/);
    expect(() => assertPlanAllowed(two, launchPolicy(), { finalCall: true })).toThrow(refused);
  });

  it('requires the final step to be a call, and refuses an empty plan', () => {
    const p = launchPolicy({ feeCurrency: USDC, maxApproveAmount: 5n });
    expect(() => assertPlanAllowed([step('approve', approveTx(USDC, FACTORY, 5n))], p, { finalCall: true })).toThrow(/langkah terakhir harus/);
    expect(() => assertPlanAllowed([], launchPolicy(), { finalCall: true })).toThrow(/kosong/);
  });

  it('approvals-only mode (swap prerequisites) refuses a swap call smuggled into a quote (review finding)', () => {
    const p = swapPolicy({ quoteAddress: ZERO, maxTotalNativeValue: 50n });
    expect(() => assertPlanAllowed([step('swap', tx({ to: ROUTER, value: '50' }))], p, { finalCall: false })).toThrow(/hanya approve/);
    const erc20 = swapPolicy();
    const ok = assertPlanAllowed([step('a1', approveTx(USDC, PERMIT2, maxUint256)), step('a2', approveTx(USDC, ROUTER, AMOUNT))], erc20, { finalCall: false });
    expect(ok.map((c) => c.kind)).toEqual(['approve', 'approve']);
  });
});

describe('assertTypedDataAllowed', () => {
  const permit = (message: Record<string, unknown> = {}, overrides: Partial<TypedDataRequest> = {}): TypedDataRequest => ({
    domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2 },
    types: {
      PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
      PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
    },
    primaryType: 'PermitSingle',
    message: {
      details: { token: USDC, amount: AMOUNT.toString(), expiration: NOW + 30 * 86400, nonce: 0 },
      spender: ROUTER,
      sigDeadline: String(NOW + 1800),
      ...message,
    },
    ...overrides,
  });
  const details = (over: Record<string, unknown>) => ({ details: { token: USDC, amount: AMOUNT.toString(), expiration: NOW + 86400, nonce: 0, ...over } });

  it('accepts a normal permit: reviewed pair, bounded amount, router spender, sane expirations', () => {
    expect(() => assertTypedDataAllowed(permit(), swapPolicy())).not.toThrow();
    expect(() => assertTypedDataAllowed(permit(details({ amount: '1' })), swapPolicy())).not.toThrow();
  });

  it('refuses an unbounded permit (amount 2^160-1, expiration 2^48-1, sigDeadline 2^255)', () => {
    expect(() => assertTypedDataAllowed(permit(details({ amount: maxUint160.toString() })), swapPolicy())).toThrow(/melebihi batas/);
    expect(() => assertTypedDataAllowed(permit(details({ expiration: 2 ** 48 - 1 })), swapPolicy())).toThrow(/masa berlaku/);
    expect(() => assertTypedDataAllowed(permit({ sigDeadline: (2n ** 255n).toString() }), swapPolicy())).toThrow(/batas waktu tanda tangan/);
    expect(() => assertTypedDataAllowed(permit(details({ expiration: NOW - 10 })), swapPolicy())).toThrow(/masa berlaku/);
    expect(() => assertTypedDataAllowed(permit({ sigDeadline: String(NOW - 10) }), swapPolicy())).toThrow(/batas waktu/);
  });

  it('refuses wrong types, domains, spenders and tokens', () => {
    expect(() => assertTypedDataAllowed(permit({}, { primaryType: 'Order' }), swapPolicy())).toThrow(/tidak didukung/);
    expect(() => assertTypedDataAllowed(permit({}, { domain: { name: 'Other', chainId: 8453, verifyingContract: PERMIT2 } }), swapPolicy())).toThrow(/bukan Permit2/);
    expect(() => assertTypedDataAllowed(permit({}, { domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 } }), swapPolicy())).toThrow(/chain/);
    expect(() => assertTypedDataAllowed(permit({}, { domain: { name: 'Permit2', chainId: 8453, verifyingContract: ATTACKER } }), swapPolicy())).toThrow(/Permit2/);
    for (const spender of [ATTACKER, PERMIT2, FACTORY]) expect(() => assertTypedDataAllowed(permit({ spender }), swapPolicy()), spender).toThrow(/spender/);
    expect(() => assertTypedDataAllowed(permit(details({ token: ATTACKER })), swapPolicy())).toThrow(/pair/);
    expect(() => assertTypedDataAllowed(permit(details({ amount: 'not-a-number' })), swapPolicy())).toThrow(/tidak valid/);
  });

  it('refuses any permit when the suite has no Permit2', () => {
    const noPermit: ContractSuite = { ...suite('tax'), contracts: { ...suite('tax').contracts, permit2: undefined } };
    expect(() => assertTypedDataAllowed(permit(), swapPolicy({ suite: noPermit }))).toThrow(/Permit2/);
  });
});

describe('EXTRA_ALLOWED_TARGETS (explicit trust, not a blanket switch)', () => {
  const EXTRA = addr(0xe17a);

  it('makes a router callable and a valid spender, but keeps every amount bound', () => {
    const p = swapPolicy({ extraTargets: [EXTRA] });
    expect(checkTx(tx({ to: EXTRA, value: '0' }), p, 'swap').kind).toBe('call');
    expect(checkTx(approveTx(USDC, EXTRA, AMOUNT), p, 'a').kind).toBe('approve');
    expect(() => checkTx(approveTx(USDC, EXTRA, maxUint256), p, 'a')).toThrow(/melebihi batas/);
    expect(() => checkTx(approveTx(USDC, ATTACKER, 1n), p, 'a')).toThrow(/spender/); // others are still refused
  });

  it('ignores invalid and zero entries, and does not open up Permit2 as a call target', () => {
    const p = swapPolicy({ extraTargets: ['nope', ZERO] });
    expect(p.callTargets.has(ZERO)).toBe(false);
    expect(() => checkTx(tx({ to: PERMIT2, value: '0' }), p, 'x')).toThrow(refused);
  });
});
