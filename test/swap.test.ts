import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { coerceTypedData, extractTxSteps, extractTypedData } from '../src/o1/swap.js';
import type { TypedDataRequest } from '../src/o1/types.js';
import { PERMIT2, ROUTER, USDC, WALLET } from './fixtures.js';

const tx = (data = '0x1234') => ({ chain_id: 8453, from: WALLET, to: ROUTER, data, value: '0' });

describe('extractTxSteps', () => {
  it('reads the documented steps[] shape in order and reports not_run steps', () => {
    const steps = extractTxSteps({
      steps: [
        { id: 'approve', kind: 'transaction', label: 'Approve', depends_on: [], transaction: tx('0xaa'), simulation: { status: 'succeeded' } },
        { id: 'permit', kind: 'typed_data', label: 'Permit', depends_on: [], typed_data: {} },
        { id: 'swap', kind: 'transaction', label: 'Swap', depends_on: ['approve'], transaction: tx('0xbb'), simulation: { status: 'not_run' } },
      ],
    });
    expect(steps.map((s) => s.id)).toEqual(['approve', 'swap']);
    expect(steps.map((s) => s.simulationNotRun)).toEqual([false, true]);
    expect(steps[1]?.dependsOn).toEqual(['approve']);
  });

  it('accepts a single top-level transaction or a bare tx-shaped result', () => {
    expect(extractTxSteps({ transaction: tx() })).toHaveLength(1);
    expect(extractTxSteps(tx())).toHaveLength(1);
  });

  it('ignores steps that do not look like transactions and returns [] for junk', () => {
    expect(extractTxSteps({ steps: [{ id: 'x', kind: 'transaction', transaction: { to: 'nope' } }] })).toEqual([]);
    expect(extractTxSteps(null)).toEqual([]);
    expect(extractTxSteps('x')).toEqual([]);
    expect(extractTxSteps({ quote_id: 'q' })).toEqual([]);
  });
});

const permit: TypedDataRequest = {
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
  message: {
    details: { token: USDC, amount: '1000000', expiration: 1_900_000_000, nonce: 0 },
    spender: ROUTER,
    sigDeadline: '1900000000',
  },
};

describe('extractTypedData / coerceTypedData', () => {
  it('finds typed data in a step or under a known key', () => {
    expect(extractTypedData({ steps: [{ id: 'p', kind: 'typed_data', typed_data: permit }] })).toBe(permit);
    expect(extractTypedData({ permit2: permit })).toBe(permit);
    expect(extractTypedData({ steps: [] })).toBeNull();
    expect(extractTypedData(undefined)).toBeNull();
  });

  it('converts numeric strings to bigint following the type map, recursively', () => {
    const { message } = coerceTypedData(permit);
    expect(message.sigDeadline).toBe(1_900_000_000n);
    expect(message.details).toEqual({ token: USDC, amount: 1_000_000n, expiration: 1_900_000_000n, nonce: 0n });
    expect(message.spender).toBe(ROUTER);
  });

  it('drops a supplied EIP712Domain type (viem derives it)', () => {
    const withDomain: TypedDataRequest = { ...permit, types: { ...permit.types, EIP712Domain: [{ name: 'name', type: 'string' }] } };
    expect(coerceTypedData(withDomain).types).not.toHaveProperty('EIP712Domain');
  });

  it('produces a payload that a real key can sign and whose signer can be recovered', async () => {
    const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const typed = coerceTypedData(permit);
    const signature = await account.signTypedData(typed as never);
    const recovered = await recoverTypedDataAddress({ ...(typed as Record<string, unknown>), signature } as never);
    expect(recovered).toBe(account.address);
  });
});
