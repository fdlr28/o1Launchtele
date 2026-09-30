import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import { assertTxAllowed, assertTypedDataAllowed, guardPolicyFor } from '../src/services/guard.js';
import type { TransactionRequest, TypedDataRequest } from '../src/o1/types.js';
import { FACTORY, PERMIT2, ROUTER, USDC, WALLET, ZERO, addr, suite } from './fixtures.js';

const FEE = 1_000_000_000_000_000n;

function policy(overrides: Partial<Parameters<typeof guardPolicyFor>[0]> = {}) {
  return guardPolicyFor({
    chainId: 8453,
    from: WALLET,
    suite: suite('tax'),
    quoteAddress: USDC,
    maxNativeValue: FEE,
    strict: true,
    ...overrides,
  });
}

function tx(overrides: Partial<TransactionRequest> = {}): TransactionRequest {
  return { chain_id: 8453, from: WALLET, to: FACTORY, data: '0xdeadbeef', value: FEE.toString(), ...overrides };
}

const approve = (spender: Address, amount = 1n) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
const transfer = (to: Address) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, 1n] });

describe('assertTxAllowed', () => {
  it('lets a launch to the factory with the reviewed fee through, unchanged', () => {
    const safe = assertTxAllowed(tx(), policy(), 'launch');
    expect(safe).toEqual({ to: FACTORY, data: '0xdeadbeef', value: FEE });
  });

  it('accepts a lower value than the cap', () => {
    expect(assertTxAllowed(tx({ value: '0' }), policy(), 'x').value).toBe(0n);
  });

  it('rejects a value above what the user reviewed', () => {
    expect(() => assertTxAllowed(tx({ value: (FEE + 1n).toString() }), policy(), 'launch')).toThrow(/melebihi/);
  });

  it('rejects a wrong chain, a foreign sender and unknown targets', () => {
    expect(() => assertTxAllowed(tx({ chain_id: 1 }), policy(), 'x')).toThrow(/chain/);
    expect(() => assertTxAllowed(tx({ from: addr(0xbad) }), policy(), 'x')).toThrow(/pengirim/);
    expect(() => assertTxAllowed(tx({ to: addr(0xbad) }), policy(), 'x')).toThrow(/tidak dikenal|bukan kontrak/);
  });

  it('rejects malformed fields', () => {
    expect(() => assertTxAllowed(tx({ to: 'nope' as Address }), policy(), 'x')).toThrow(UserFacingError);
    expect(() => assertTxAllowed(tx({ data: 'zz' as never }), policy(), 'x')).toThrow(/calldata/);
    expect(() => assertTxAllowed(tx({ value: '-1' }), policy(), 'x')).toThrow(/value/);
    expect(() => assertTxAllowed(tx({ value: '1.5' }), policy(), 'x')).toThrow(/value/);
  });

  it('permits approve on the quote token only for known spenders and with zero value', () => {
    const ok = tx({ to: USDC, data: approve(ROUTER), value: '0' });
    expect(assertTxAllowed(ok, policy(), 'approve').to).toBe(USDC);
    expect(() => assertTxAllowed(tx({ to: USDC, data: approve(addr(0xbad)), value: '0' }), policy(), 'approve')).toThrow(/spender/);
    expect(() => assertTxAllowed(tx({ to: USDC, data: approve(ROUTER), value: '1' }), policy(), 'approve')).toThrow(/value/);
  });

  it('never lets an ERC-20 target receive anything but approve', () => {
    expect(() => assertTxAllowed(tx({ to: USDC, data: transfer(addr(0xbad)), value: '0' }), policy(), 'x')).toThrow(/approve/);
  });

  it('allows Permit2 as an approve spender', () => {
    expect(assertTxAllowed(tx({ to: USDC, data: approve(PERMIT2), value: '0' }), policy(), 'x').value).toBe(0n);
  });

  it('skips the allow-list only when strict is off, but still enforces chain/sender/value', () => {
    const loose = policy({ strict: false });
    expect(assertTxAllowed(tx({ to: addr(0xbad) }), loose, 'x').to).toBe(addr(0xbad));
    expect(() => assertTxAllowed(tx({ to: addr(0xbad), chain_id: 1 }), loose, 'x')).toThrow(/chain/);
    expect(() => assertTxAllowed(tx({ to: addr(0xbad), value: (FEE + 1n).toString() }), loose, 'x')).toThrow(/melebihi/);
  });

  it('a native quote adds no ERC-20 target, so a transfer-looking call to a router is still an allowed target', () => {
    const nativePolicy = policy({ quoteAddress: ZERO });
    expect(nativePolicy.erc20Targets.size).toBe(0);
    expect(assertTxAllowed(tx({ to: ROUTER, data: '0x12345678' }), nativePolicy, 'swap').to).toBe(ROUTER);
  });
});

describe('assertTypedDataAllowed', () => {
  const permit = (overrides: Record<string, unknown> = {}): TypedDataRequest => ({
    domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2 },
    types: {
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
    },
    primaryType: 'PermitSingle',
    message: { details: { token: USDC, amount: '100', expiration: 1, nonce: 0 }, spender: ROUTER, sigDeadline: '999', ...overrides },
  });

  it('accepts a normal Permit2 single permit for the quote token', () => {
    expect(() => assertTypedDataAllowed(permit(), policy())).not.toThrow();
  });

  it('rejects other primary types, wrong chain, wrong verifying contract, unknown spender or token', () => {
    expect(() => assertTypedDataAllowed({ ...permit(), primaryType: 'Order' }, policy())).toThrow(/tidak didukung/);
    expect(() => assertTypedDataAllowed({ ...permit(), domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 } }, policy())).toThrow(/chain/);
    expect(() => assertTypedDataAllowed({ ...permit(), domain: { name: 'Permit2', chainId: 8453, verifyingContract: addr(0xbad) } }, policy())).toThrow(/Permit2/);
    expect(() => assertTypedDataAllowed(permit({ spender: addr(0xbad) }), policy())).toThrow(/spender/);
    expect(() => assertTypedDataAllowed(permit({ details: { token: addr(0xbad), amount: '1', expiration: 1, nonce: 0 } }), policy())).toThrow(/token/);
  });
});
