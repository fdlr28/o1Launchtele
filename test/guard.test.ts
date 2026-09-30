import { encodeFunctionData, erc20Abi, getAddress, maxUint160, maxUint256, parseAbi, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import {
  CANONICAL_PERMIT2,
  MAX_PLAN_STEPS,
  assertPlanAllowed,
  assertTypedDataAllowed,
  checkTx,
  guardPolicyFor,
  type GuardInput,
} from '../src/services/guard.js';
import type { ContractSuite, TransactionRequest, TypedDataRequest } from '../src/o1/types.js';
import { FACTORY, HOOK, PERMIT2, ROUTER, USDC, WALLET, ZERO, addr, suite } from './fixtures.js';

const FEE = 1_000_000_000_000_000n; // reviewed creation fee (native)
const AMOUNT = 5_000_000n; // reviewed dev buy amount (5 USDC)
const NOW = 1_800_000_000;
const ATTACKER = addr(0xbad);

const permit2Abi = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);

/** A suite whose /config claims other contracts than the fixture's, as a hostile or broken API might. */
const suiteWith = (contracts: Partial<ContractSuite['contracts']>): ContractSuite => ({ ...suite('tax'), contracts: { ...suite('tax').contracts, ...contracts } });

function launchPolicy(overrides: Partial<GuardInput> = {}) {
  return guardPolicyFor({
    chainId: 8453, from: WALLET, suite: suite('tax'), kind: 'launch', erc20: [], maxTotalNativeValue: FEE, nowSec: () => NOW, ...overrides,
  });
}

/** A launch that pays its creation fee in USDC (at most 5 units). */
const usdcFee = (max = 5n) => ({ erc20: [{ address: USDC, maxApprove: max, maxPermit: 0n }], maxTotalNativeValue: 0n });

function swapPolicy(overrides: Partial<GuardInput> = {}) {
  return guardPolicyFor({
    chainId: 8453, from: WALLET, suite: suite('tax'), kind: 'swap', erc20: [{ address: USDC, maxApprove: AMOUNT, maxPermit: AMOUNT }], maxTotalNativeValue: 0n, nowSec: () => NOW, ...overrides,
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
    expect(() => checkTx(tx({ to: ZERO }), launchPolicy({ suite: suiteWith({ factory: ZERO }) }), 'x')).toThrow(refused);
  });

  it('ERC-20 fee token: approve to the factory up to the fee, nothing else', () => {
    const p = launchPolicy(usdcFee());
    expect(checkTx(approveTx(USDC, FACTORY, 5n), p, 'approve').kind).toBe('approve');
    expect(() => checkTx(approveTx(USDC, FACTORY, 6n), p, 'approve')).toThrow(/melebihi batas/);
    expect(() => checkTx(approveTx(USDC, FACTORY, maxUint256), p, 'approve')).toThrow(/melebihi batas/);
    expect(() => checkTx(approveTx(USDC, ATTACKER), p, 'approve')).toThrow(/spender/);
    expect(() => checkTx(approveTx(USDC, ROUTER), p, 'approve')).toThrow(/spender/); // not a launch spender
    expect(() => checkTx({ ...tx({ to: USDC, value: '0' }), data: transfer(ATTACKER) }, p, 'x')).toThrow(/hanya boleh menerima approve/);
    expect(() => checkTx({ ...approveTx(USDC, FACTORY), value: '1' }, launchPolicy({ ...usdcFee(), maxTotalNativeValue: 10n }), 'x')).toThrow(/value/);
    // trailing bytes after a well-formed approve are not standard calldata
    expect(() => checkTx({ ...approveTx(USDC, FACTORY), data: `${approve(FACTORY)}00` }, p, 'x')).toThrow(/tidak standar/);
  });

  it('a native-fee launch touches no token at all: not even the pair can be approved (round-2 review)', () => {
    const p = launchPolicy();
    for (const token of [USDC, addr(0x9999)]) expect(() => checkTx(approveTx(token, FACTORY, 1n), p, 'x'), token).toThrow(refused);
    // and Permit2 is not part of a launch
    expect(() => checkTx(approveTx(USDC, PERMIT2, 1n), launchPolicy(usdcFee()), 'x')).toThrow(/spender/);
  });
});

describe('every ERC-20 has its own bound (round-2 review)', () => {
  const DAI = addr(0xda1);
  const BIG = 10n ** 19n; // a large allowance in an 18-decimals token

  it('an allowance that is fine for one token is refused for another', () => {
    const p = launchPolicy({ erc20: [{ address: DAI, maxApprove: BIG, maxPermit: 0n }, { address: USDC, maxApprove: 5n, maxPermit: 0n }], maxTotalNativeValue: 0n });
    expect(checkTx(approveTx(DAI, FACTORY, BIG), p, 'a').kind).toBe('approve');
    expect(checkTx(approveTx(USDC, FACTORY, 5n), p, 'a').kind).toBe('approve');
    // one shared scalar would have let 1e19 units of USDC through (10^13 USDC)
    expect(() => checkTx(approveTx(USDC, FACTORY, BIG), p, 'a')).toThrow(/melebihi batas 5/);
  });
});

describe('checkTx: a swap step', () => {
  it('accepts a router call with native value up to the reviewed amount', () => {
    const p = swapPolicy({ erc20: [], maxTotalNativeValue: 50n });
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

  it('allows an unlimited ERC-20 allowance to the canonical Permit2 only; other spenders are capped at the reviewed amount', () => {
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

  it('a native pair needs no allowance: every approve is refused', () => {
    const p = swapPolicy({ erc20: [], maxTotalNativeValue: 50n });
    expect(() => checkTx(approveTx(USDC, PERMIT2, 1n), p, 'a')).toThrow(refused);
  });
});

describe('the trust anchor: a hostile /config cannot buy an unlimited allowance (round-2 review, CRITICAL)', () => {
  const hostile = suiteWith({ permit2: ATTACKER, swapx_router: ATTACKER });

  it('an unlimited approval goes to the canonical Permit2 and to nobody /config names', () => {
    const p = swapPolicy({ suite: hostile });
    expect(checkTx(approveTx(USDC, CANONICAL_PERMIT2 as Address, maxUint256), p, 'a').kind).toBe('approve');
    // the "Permit2" the API claims is just an attacker: not even a bounded approval is allowed to it
    expect(() => checkTx(approveTx(USDC, ATTACKER, maxUint256), p, 'a')).toThrow(/melebihi batas/); // it is only a router here...
    expect(p.permit2.has(ATTACKER.toLowerCase())).toBe(false);
  });

  it('a hostile router can be paid the reviewed amount and not a unit more', () => {
    const p = swapPolicy({ suite: hostile });
    expect(checkTx(approveTx(USDC, ATTACKER, AMOUNT), p, 'a').kind).toBe('approve');
    expect(() => checkTx(approveTx(USDC, ATTACKER, AMOUNT + 1n), p, 'a')).toThrow(/melebihi batas/);
    expect(() => checkTx(approveTx(USDC, ATTACKER, maxUint256), p, 'a')).toThrow(/melebihi batas/);
  });

  it('a hostile /config Permit2 is refused as spender when it is only claimed, and accepted when the owner vouches for it', () => {
    const claims = suiteWith({ permit2: ATTACKER });
    expect(() => checkTx(approveTx(USDC, ATTACKER, 1n), swapPolicy({ suite: claims }), 'a')).toThrow(/spender/);
    const vouched = swapPolicy({ suite: claims, extraTargets: [ATTACKER] });
    expect(vouched.permit2.has(ATTACKER.toLowerCase())).toBe(true);
    expect(checkTx(approveTx(USDC, ATTACKER, maxUint256), vouched, 'a').kind).toBe('approve');
    // ... but even then it is a spender only, never a contract the bot calls
    expect(() => checkTx(tx({ to: ATTACKER, value: '0' }), vouched, 'x')).toThrow(refused);
  });

  it('the canonical address is the well-known Permit2', () => {
    expect(getAddress(CANONICAL_PERMIT2)).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
    expect(PERMIT2.toLowerCase()).toBe(CANONICAL_PERMIT2);
  });

  it('there is no Permit2 in a launch plan at all', () => {
    expect(launchPolicy().permit2.size).toBe(0);
  });
});

describe('assertPlanAllowed: the whole plan is judged before anything is sent', () => {
  const step = (id: string, transaction: TransactionRequest) => ({ id, transaction });
  const launch = () => step('launch', tx({ value: FEE.toString() }));

  it('accepts approvals followed by exactly one final call', () => {
    const p = launchPolicy({ ...usdcFee(), maxTotalNativeValue: FEE });
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
    const p = launchPolicy(usdcFee());
    expect(() => assertPlanAllowed([step('approve', approveTx(USDC, FACTORY, 5n))], p, { finalCall: true })).toThrow(/langkah terakhir harus/);
    expect(() => assertPlanAllowed([], launchPolicy(), { finalCall: true })).toThrow(/kosong/);
  });

  it('approvals-only mode (swap prerequisites) refuses a swap call smuggled into a quote (review finding)', () => {
    const p = swapPolicy({ erc20: [], maxTotalNativeValue: 50n });
    expect(() => assertPlanAllowed([step('swap', tx({ to: ROUTER, value: '50' }))], p, { finalCall: false })).toThrow(/hanya approve/);
    const erc20 = swapPolicy();
    const ok = assertPlanAllowed([step('a1', approveTx(USDC, PERMIT2, maxUint256)), step('a2', approveTx(USDC, ROUTER, AMOUNT))], erc20, { finalCall: false });
    expect(ok.map((c) => c.kind)).toEqual(['approve', 'approve']);
  });
});

describe('assertTypedDataAllowed', () => {
  const TYPES: TypedDataRequest['types'] = {
    PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
    PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  };
  const permit = (message: Record<string, unknown> = {}, overrides: Partial<TypedDataRequest> = {}): TypedDataRequest => ({
    domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2 },
    types: TYPES,
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

  it('returns the payload REBUILT from the validated fields, so the signer signs exactly what was checked', () => {
    const noisy = permit({ extra: 'ignored', details: { token: USDC.toLowerCase(), amount: AMOUNT.toString(), expiration: NOW + 86400, nonce: '7', junk: 1 } });
    const payload = assertTypedDataAllowed(noisy, swapPolicy());
    expect(payload.domain).toEqual({ name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2 });
    expect(payload.primaryType).toBe('PermitSingle');
    expect(payload.message).toEqual({
      details: { token: getAddress(USDC), amount: AMOUNT, expiration: BigInt(NOW + 86400), nonce: 7n },
      spender: getAddress(ROUTER),
      sigDeadline: BigInt(NOW + 1800),
    });
    // nothing of the API's own objects is reused
    expect(payload.types).not.toBe(noisy.types);
    expect(payload.types).toEqual(TYPES);
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
    expect(() => assertTypedDataAllowed(permit({}, { domain: { name: 'Permit2', chainId: 8453, verifyingContract: ATTACKER } }), swapPolicy())).toThrow(/bukan yang dipercaya/);
    for (const spender of [ATTACKER, PERMIT2, FACTORY]) expect(() => assertTypedDataAllowed(permit({ spender }), swapPolicy()), spender).toThrow(/spender/);
    expect(() => assertTypedDataAllowed(permit(details({ token: ATTACKER })), swapPolicy())).toThrow(/pair/);
    expect(() => assertTypedDataAllowed(permit(details({ amount: 'not-a-number' })), swapPolicy())).toThrow(/tidak valid/);
  });

  it('trusts the canonical Permit2 even when /config omits it, and never a /config Permit2 the owner did not vouch for', () => {
    const none = swapPolicy({ suite: suiteWith({ permit2: undefined }) });
    expect(() => assertTypedDataAllowed(permit(), none)).not.toThrow();

    const claims = suiteWith({ permit2: ATTACKER });
    const attackerDomain = permit({}, { domain: { name: 'Permit2', chainId: 8453, verifyingContract: ATTACKER } });
    expect(() => assertTypedDataAllowed(attackerDomain, swapPolicy({ suite: claims }))).toThrow(/bukan yang dipercaya/);
    expect(() => assertTypedDataAllowed(attackerDomain, swapPolicy({ suite: claims, extraTargets: [ATTACKER] }))).not.toThrow();
  });

  it('refuses a permit for a native-pair swap (there is nothing to permit)', () => {
    expect(() => assertTypedDataAllowed(permit(), swapPolicy({ erc20: [] }))).toThrow(/pair/);
  });

  describe('the checker and the signer cannot disagree (round-2 review)', () => {
    it('accepts a decimal-string chain id and rejects every other spelling', () => {
      expect(() => assertTypedDataAllowed(permit({}, { domain: { name: 'Permit2', chainId: '8453' as never, verifyingContract: PERMIT2 } }), swapPolicy())).not.toThrow();
      for (const chainId of ['0x2105', [8453], '8453.0', ' 8453', 8453.5, null, undefined, true]) {
        const bad = permit({}, { domain: { name: 'Permit2', chainId: chainId as never, verifyingContract: PERMIT2 } });
        expect(() => assertTypedDataAllowed(bad, swapPolicy()), String(chainId)).toThrow(/chain pada domain/);
      }
    });

    it('rejects domains with extra fields (the real Permit2 domain has exactly three)', () => {
      const bad = permit({}, { domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2, version: '1' } });
      expect(() => assertTypedDataAllowed(bad, swapPolicy())).toThrow(/field yang tidak dikenal \(version\)/);
    });

    it('rejects a type map that differs from the real PermitSingle, including a reordered field', () => {
      const reordered = { ...TYPES, PermitDetails: [TYPES.PermitDetails![1]!, TYPES.PermitDetails![0]!, ...TYPES.PermitDetails!.slice(2)] };
      expect(() => assertTypedDataAllowed(permit({}, { types: reordered }), swapPolicy())).toThrow(/struktur tipe/);
      const extra = { ...TYPES, PermitSingle: [...TYPES.PermitSingle!, { name: 'note', type: 'string' }] };
      expect(() => assertTypedDataAllowed(permit({}, { types: extra }), swapPolicy())).toThrow(/struktur tipe/);
      // a supplied EIP712Domain entry is ignored, as viem derives the domain itself
      const withDomain = { ...TYPES, EIP712Domain: [{ name: 'name', type: 'string' }] };
      expect(() => assertTypedDataAllowed(permit({}, { types: withDomain }), swapPolicy())).not.toThrow();
    });

    it('parses numbers strictly: only bigint, safe integers and plain decimal strings', () => {
      for (const amount of ['0x10', ' 5', '5 ', '-1', '1e6', '1.0', '', '05', 1.5, Number.MAX_SAFE_INTEGER + 2, null, [5], { n: 5 }]) {
        expect(() => assertTypedDataAllowed(permit(details({ amount })), swapPolicy()), String(amount)).toThrow(/tidak valid/);
      }
      expect(() => assertTypedDataAllowed(permit(details({ amount: 5n })), swapPolicy())).not.toThrow();
      expect(() => assertTypedDataAllowed(permit(details({ amount: -1 })), swapPolicy())).toThrow(/di luar jangkauan/);
      expect(() => assertTypedDataAllowed(permit(details({ nonce: 2 ** 48 })), swapPolicy())).toThrow(/di luar jangkauan/);
      expect(() => assertTypedDataAllowed(permit(details({ amount: (2n ** 160n).toString() })), swapPolicy())).toThrow(/di luar jangkauan/);
    });
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
    // not even when the owner lists the canonical Permit2 itself
    const listed = swapPolicy({ extraTargets: [PERMIT2] });
    expect(() => checkTx(tx({ to: PERMIT2, value: '0' }), listed, 'x')).toThrow(refused);
    expect(checkTx(approveTx(USDC, PERMIT2, maxUint256), listed, 'a').kind).toBe('approve');
  });
});
