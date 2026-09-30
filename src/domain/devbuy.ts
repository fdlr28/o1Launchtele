import type { ContractSuite } from '../o1/types.js';
import type { Draft } from './draft.js';
import { readTaxPolicy } from './tax.js';

/**
 * Standard launches charge an opening anti-snipe surcharge that decays linearly from 99% to the
 * normal 1% fee. Documented windows (docs.o1.exchange/launchpad/trading/fees-referrals):
 * 20 seconds on Base, Robinhood, Monad, BSC and X Layer; none on Arc.
 * A pool freezes its own schedule, so an unknown chain falls back to the longer, safer value.
 */
export const STANDARD_ANTI_SNIPE_SECONDS: Record<number, number> = {
  8453: 20,
  4663: 20,
  143: 20,
  56: 20,
  196: 20,
  5042: 0,
};

const FALLBACK_WINDOW_SECONDS = 20;

/** Seconds during which a buy pays the extra anti-snipe surcharge on top of the normal fee. */
export function antiSnipeWindowSeconds(draft: Pick<Draft, 'product' | 'chainId' | 'tax'>, suite: ContractSuite | undefined): number {
  if (draft.product === 'tax') {
    if (!draft.tax.antiSnipe) return 0;
    const policy = suite ? readTaxPolicy(suite) : null;
    return policy?.antiSnipeWindowSeconds ?? FALLBACK_WINDOW_SECONDS;
  }
  return STANDARD_ANTI_SNIPE_SECONDS[draft.chainId] ?? FALLBACK_WINDOW_SECONDS;
}

/** Extra seconds added after the window so the surcharge has fully decayed when we buy. */
export const ANTI_SNIPE_MARGIN_SECONDS = 3;
