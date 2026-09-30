import { antiSnipeWindowSeconds } from '../domain/devbuy.js';
import type { Draft } from '../domain/draft.js';
import { readTaxPolicy, type TaxPolicy } from '../domain/tax.js';
import { formatAmount } from '../domain/units.js';
import { describeError } from '../errors.js';
import { isNativeQuote, type Catalog } from '../o1/catalog.js';
import { draftProblems } from '../o1/launchRequest.js';
import type { Wallet } from '../wallet/wallet.js';
import { resolveLaunchContext, type LaunchContext } from './context.js';
import { DraftAlreadyLaunchedError, NO_FEE, PendingLaunchError, contractsOf, type Launcher, type ReviewedContracts, type ReviewedFee } from './launcher.js';

/** One line of the funds check: what the wallet holds against what the launch needs. */
export interface FundsLine {
  symbol: string;
  decimals: number;
  isNative: boolean;
  balanceRaw: bigint | null;
  requiredRaw: bigint;
}

export interface Review {
  ok: boolean;
  problems: string[];
  warnings: string[];
  ctx: LaunchContext | null;
  taxPolicy: TaxPolicy | null;
  /** The creation fee the owner is about to accept; the launch aborts if the live fee is higher. */
  reviewedFee: ReviewedFee | null;
  /** The o1 contracts that will receive the money; the launch aborts if they change after the review. */
  contracts: ReviewedContracts | null;
  funds: FundsLine[];
}

export interface ReviewDeps {
  catalog: Catalog;
  wallet: Wallet;
  launcher: Pick<Launcher, 'pendingLaunches' | 'priorLaunch'>;
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

  // The history is what prevents a second launch: if it cannot be read, or says this draft (or another launch)
  // is already on its way, there is no green light.
  try {
    const pending = await deps.launcher.pendingLaunches();
    if (pending.length > 0) {
      problems.push(new PendingLaunchError(pending).message);
    } else {
      const prior = await deps.launcher.priorLaunch(draft.id);
      if (prior) problems.push(new DraftAlreadyLaunchedError(prior).message);
    }
  } catch (err) {
    problems.push(describeError(err));
  }

  const taxPolicy = ctx && draft.product === 'tax' ? readTaxPolicy(ctx.suite) : null;
  const devBuyAmount = draft.devBuy.enabled && draft.devBuy.amountRaw ? BigInt(draft.devBuy.amountRaw) : 0n;
  const nativeQuote = draft.quote ? isNativeQuote(draft.quote) : false;
  const funds: FundsLine[] = [];

  if (ctx) {
    const fee = ctx.fee;
    const feeToken = fee && !fee.isNative ? fee : null;

    // Native currency: creation fee (when paid natively) + a native dev buy. Gas comes on top.
    const requiredNative = (fee?.isNative ? fee.amountRaw : 0n) + (nativeQuote ? devBuyAmount : 0n);
    // ERC-20s: an ERC-20 creation fee and/or an ERC-20 dev buy (possibly the same token).
    const erc20 = new Map<string, { symbol: string; decimals: number; required: bigint; address: `0x${string}` }>();
    const need = (address: `0x${string}`, symbol: string, decimals: number, amount: bigint) => {
      if (amount <= 0n) return;
      const key = address.toLowerCase();
      const line = erc20.get(key);
      if (line) line.required += amount;
      else erc20.set(key, { symbol, decimals, required: amount, address });
    };
    if (feeToken) need(feeToken.currency, feeToken.symbol, feeToken.decimals, feeToken.amountRaw);
    if (draft.quote && !nativeQuote) need(draft.quote.address, draft.quote.symbol, draft.quote.decimals, devBuyAmount);

    try {
      const balanceNative = await deps.wallet.nativeBalance(draft.chainId);
      funds.push({ symbol: ctx.nativeSymbol, decimals: ctx.nativeDecimals, isNative: true, balanceRaw: balanceNative, requiredRaw: requiredNative });
      if (balanceNative < requiredNative) {
        problems.push(
          `Saldo ${ctx.nativeSymbol} kurang: punya ${formatAmount(balanceNative, ctx.nativeDecimals)}, butuh minimal ${formatAmount(requiredNative, ctx.nativeDecimals)} (belum termasuk gas).`,
        );
      }
      for (const token of erc20.values()) {
        const balance = await deps.wallet.erc20Balance(draft.chainId, token.address);
        funds.push({ symbol: token.symbol, decimals: token.decimals, isNative: false, balanceRaw: balance, requiredRaw: token.required });
        if (balance < token.required) {
          problems.push(
            `Saldo ${token.symbol} kurang: punya ${formatAmount(balance, token.decimals)}, butuh ${formatAmount(token.required, token.decimals)} (creation fee dan/atau dev buy).`,
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

  const reviewedFee: ReviewedFee | null = ctx ? (ctx.fee ? { currency: ctx.fee.currency, amountRaw: ctx.fee.amountRaw } : NO_FEE) : null;
  const contracts = ctx ? contractsOf(ctx.suite) : null;
  return { ok: problems.length === 0, problems, warnings, ctx, taxPolicy, reviewedFee, contracts, funds };
}
