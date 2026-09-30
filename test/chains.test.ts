import { describe, expect, it } from 'vitest';
import { CHAINS, DEFAULT_MAX_CREATION_FEE_WEI, DEFAULT_MAX_GAS_COST_WEI, SUPPORTED_CHAIN_IDS } from '../src/chains.js';

/** What o1 documents as the creation fee today, in native units (docs.o1.exchange/launchpad). */
const DOCUMENTED_FEE: Record<number, bigint> = {
  8453: 10n ** 15n, // 0.001 ETH
  4663: 10n ** 15n, // 0.001 ETH
  143: 100n * 10n ** 18n, // 100 MON
  5042: 2n * 10n ** 18n, // 2 native USDC
  56: 3n * 10n ** 15n, // 0.003 BNB
  196: 2n * 10n ** 16n, // 0.02 OKB
};

/** A rough, generous worst case for a launch: gas limit x a busy-network gas price, in wei. */
const BUSY_LAUNCH_COST: Record<number, bigint> = {
  8453: 5_000_000n * 10n ** 9n, // 1 gwei: a spike on Base, whose usual price is a few hundredths of a gwei
  4663: 5_000_000n * 10n ** 9n,
  143: 5_000_000n * 300n * 10n ** 9n, // 300 gwei
  5042: 5_000_000n * 600n * 10n ** 9n, // 600 gwei (Arc pays gas in USDC at a few hundred "gwei")
  56: 5_000_000n * 10n * 10n ** 9n, // 10 gwei
  196: 5_000_000n * 10n ** 9n, // 1 gwei
};

describe('the built-in ceilings (round-3 review)', () => {
  it('every supported chain has both, and they are real numbers', () => {
    for (const id of SUPPORTED_CHAIN_IDS) {
      expect(CHAINS[id]!.maxGasCostWei, String(id)).toBeGreaterThan(0n);
      expect(CHAINS[id]!.maxCreationFeeWei, String(id)).toBeGreaterThan(0n);
      expect(DOCUMENTED_FEE[id], `documented fee of ${id}`).toBeDefined();
      expect(BUSY_LAUNCH_COST[id], `gas estimate of ${id}`).toBeDefined();
    }
  });

  it('never block the fee o1 documents today (at least 5x room), and never stop meaning something (at most 100x)', () => {
    for (const id of SUPPORTED_CHAIN_IDS) {
      const cap = CHAINS[id]!.maxCreationFeeWei;
      const fee = DOCUMENTED_FEE[id]!;
      expect(cap, `fee cap of ${id} leaves room`).toBeGreaterThanOrEqual(fee * 5n);
      expect(cap, `fee cap of ${id} still bites`).toBeLessThanOrEqual(fee * 100n);
    }
  });

  it('leave room for a launch on a busy network (2x), yet stay far below a wallet-draining fee', () => {
    for (const id of SUPPORTED_CHAIN_IDS) {
      const cap = CHAINS[id]!.maxGasCostWei;
      expect(cap, `gas cap of ${id} leaves room`).toBeGreaterThanOrEqual(BUSY_LAUNCH_COST[id]! * 2n);
      expect(cap, `gas cap of ${id} still bites`).toBeLessThanOrEqual(40n * 10n ** 18n);
    }
  });

  it('have defaults for a chain that is not in the table', () => {
    expect(DEFAULT_MAX_GAS_COST_WEI).toBeGreaterThan(0n);
    expect(DEFAULT_MAX_CREATION_FEE_WEI).toBeGreaterThan(0n);
  });
});
