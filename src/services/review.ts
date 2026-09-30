import { antiSnipeWindowSeconds } from '../domain/devbuy.js';
import type { Draft } from '../domain/draft.js';
import { readTaxPolicy, type TaxPolicy } from '../domain/tax.js';
import { formatAmount } from '../domain/units.js';
import { describeError } from '../errors.js';
import { isNativeQuote, type Catalog } from '../o1/catalog.js';
import { draftProblems } from '../o1/launchRequest.js';
import type { Wallet } from '../wallet/wallet.js';
import { resolveLaunchContext, type LaunchContext } from './context.js';

export interface Review {
  ok: boolean;
  problems: string[];
  warnings: string[];
  ctx: LaunchContext | null;
  taxPolicy: TaxPolicy | null;
  /** Native currency the launcher needs (creation fee + native dev buy), excluding gas. */
  requiredNative: bigint;
  /** Quote-token amount needed when the dev buy is paid in an ERC-20 pair. */
  requiredQuote: bigint;
  balanceNative: bigint | null;
  balanceQuote: bigint | null;
}

export interface ReviewDeps {
  catalog: Catalog;
  wallet: Wallet;
}

export async function buildReview(deps: ReviewDeps, draft: Draft): Promise<Review> {
  const problems: string[] = [];
  const warnings: string[] = [];
  let ctx: LaunchContext | null = null;

  // A missing pair is reported once by draftProblems below.
  if (draft.quote) {
    try {
      ctx = await resolveLaunchContext(deps.catalog, draft);
    } catch (err) {
      problems.push(describeError(err));
    }
  }
  problems.push(...draftProblems(draft, ctx?.suite));

  const taxPolicy = ctx && draft.product === 'tax' ? readTaxPolicy(ctx.suite) : null;
  const devBuyAmount = draft.devBuy.enabled && draft.devBuy.amountRaw ? BigInt(draft.devBuy.amountRaw) : 0n;
  const nativeQuote = draft.quote ? isNativeQuote(draft.quote) : false;

  const requiredNative = (ctx?.fee?.isNative ? ctx.fee.amountRaw : 0n) + (nativeQuote ? devBuyAmount : 0n);
  const requiredQuote = !nativeQuote ? devBuyAmount : 0n;
  let balanceNative: bigint | null = null;
  let balanceQuote: bigint | null = null;

  if (ctx) {
    try {
      balanceNative = await deps.wallet.nativeBalance(draft.chainId);
      if (balanceNative < requiredNative) {
        problems.push(
          `Saldo ${ctx.nativeSymbol} kurang: punya ${formatAmount(balanceNative, ctx.nativeDecimals)}, butuh minimal ${formatAmount(requiredNative, ctx.nativeDecimals)} (belum termasuk gas).`,
        );
      }
      if (!nativeQuote && draft.quote && requiredQuote > 0n) {
        balanceQuote = await deps.wallet.erc20Balance(draft.chainId, draft.quote.address);
        if (balanceQuote < requiredQuote) {
          problems.push(
            `Saldo ${draft.quote.symbol} kurang: punya ${formatAmount(balanceQuote, draft.quote.decimals)}, butuh ${formatAmount(requiredQuote, draft.quote.decimals)} untuk dev buy.`,
          );
        }
      }
    } catch (err) {
      warnings.push(`Saldo wallet tidak bisa dibaca (${describeError(err).split('\n')[0]}).`);
    }

    if (draft.devBuy.enabled && draft.devBuy.timing === 'now') {
      const window = antiSnipeWindowSeconds(draft, ctx.suite);
      if (window > 0) {
        warnings.push(`Dev buy "segera" akan membayar surcharge anti-snipe (sampai 99% di detik-detik awal, turun dalam ${window} detik).`);
      }
    }
  }

  return { ok: problems.length === 0, problems, warnings, ctx, taxPolicy, requiredNative, requiredQuote, balanceNative, balanceQuote };
}
