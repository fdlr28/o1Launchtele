import { randomUUID } from 'node:crypto';
import { isAddress, type Address, type Hash, type Hex } from 'viem';
import { ANTI_SNIPE_MARGIN_SECONDS, antiSnipeWindowSeconds } from '../domain/devbuy.js';
import type { Draft } from '../domain/draft.js';
import { formatAmount } from '../domain/units.js';
import { TxRevertedError, TxUnknownError, UserFacingError, describeError } from '../errors.js';
import { isNativeQuote, type Catalog } from '../o1/catalog.js';
import { ApiError, type O1Api } from '../o1/client.js';
import { buildLaunchRequest } from '../o1/launchRequest.js';
import { coerceTypedData, extractTxSteps, extractTypedData, sameAddress, type ExtractedTx } from '../o1/swap.js';
import type { ContractSuite, LaunchPrepareResult, PlanIssue, SwapQuoteRequest } from '../o1/types.js';
import type { Logger } from '../logger.js';
import type { Wallet, Receipt } from '../wallet/wallet.js';
import { resolveLaunchContext, type LaunchContext } from './context.js';
import { assertTxAllowed, assertTypedDataAllowed, guardPolicyFor, type GuardPolicy } from './guard.js';
import type { History, HistoryEntry } from './history.js';

export type Stage =
  | 'checking'
  | 'preparing'
  | 'approving'
  | 'sending'
  | 'confirming'
  | 'verifying'
  | 'devbuy-indexing'
  | 'devbuy-waiting'
  | 'devbuy-quoting'
  | 'devbuy-approving'
  | 'devbuy-sending';

export interface ProgressEvent {
  stage: Stage;
  detail?: string;
  txHash?: Hash;
}

export type ProgressFn = (event: ProgressEvent) => void | Promise<void>;

export interface LaunchJob {
  /** A snapshot: later edits of the live draft must not affect a running launch. */
  draft: Draft;
  /** Native creation fee shown in the review; the launch aborts if the live fee is higher. */
  reviewedFeeRaw: bigint;
}

export type DevBuyOutcome =
  | { status: 'done'; txHash: Hash; approvalTxs: Hash[] }
  | { status: 'failed'; reason: string; txHash?: Hash };

export interface LaunchOutcome {
  chainId: number;
  token: Address;
  launchTx: Hash;
  /** False when the receipt succeeded but the predicted token address showed no code (RPC lag?). */
  codeVerified: boolean;
  devBuy?: DevBuyOutcome;
}

export interface LauncherDeps {
  api: O1Api;
  catalog: Catalog;
  wallet: Wallet;
  history: History;
  log: Logger;
  /** Reject transactions whose target is not a contract known from /config. */
  strictTargets: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_PREPARE_ROUNDS = 3;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface SendOptions {
  policy: GuardPolicy;
  kind: HistoryEntry['kind'];
  stage: Stage;
  meta: Pick<HistoryEntry, 'chainId' | 'product' | 'name' | 'symbol' | 'token' | 'quote'>;
}

export class Launcher {
  private busy = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: LauncherDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Runs one launch end to end. Only one launch may run at a time (single wallet, single nonce stream). */
  async run(job: LaunchJob, onProgress: ProgressFn = () => {}): Promise<LaunchOutcome> {
    if (this.busy) throw new UserFacingError('Masih ada launch lain yang sedang berjalan. Tunggu sampai selesai.');
    this.busy = true;
    try {
      return await this.execute(job, this.safeProgress(onProgress));
    } finally {
      this.busy = false;
    }
  }

  private safeProgress(fn: ProgressFn): ProgressFn {
    return async (event) => {
      try {
        await fn(event);
      } catch (err) {
        this.deps.log.debug('progress callback failed', err);
      }
    };
  }

  private async execute(job: LaunchJob, progress: ProgressFn): Promise<LaunchOutcome> {
    const { draft } = job;
    const { wallet, api, catalog } = this.deps;
    const chainId = draft.chainId;

    await progress({ stage: 'checking' });
    const ctx = await resolveLaunchContext(catalog, draft, { fresh: true });
    const feeNative = ctx.fee?.isNative ? ctx.fee.amountRaw : 0n;
    if (feeNative > job.reviewedFeeRaw) {
      throw new UserFacingError(
        `Fee launch naik menjadi ${formatAmount(feeNative, ctx.nativeDecimals)} ${ctx.nativeSymbol} ` +
          `(saat review: ${formatAmount(job.reviewedFeeRaw, ctx.nativeDecimals)}). Buka Review lagi lalu konfirmasi ulang.`,
      );
    }

    const request = buildLaunchRequest({ draft, creator: wallet.address, suite: ctx.suite, quote: ctx.quote });
    const policy = guardPolicyFor({
      chainId,
      from: wallet.address,
      suite: ctx.suite,
      quoteAddress: ctx.quote.address,
      feeCurrency: ctx.fee && !ctx.fee.isNative ? ctx.fee.currency : undefined,
      maxNativeValue: feeNative,
      strict: this.deps.strictTargets,
    });
    const meta = {
      chainId,
      product: draft.product,
      name: draft.name ?? undefined,
      symbol: draft.symbol ?? undefined,
      quote: ctx.quote.address,
    };

    let plan: LaunchPrepareResult | undefined;
    let launch: { hash: Hash; receipt: Receipt } | undefined;

    for (let round = 1; !launch; round++) {
      if (round > MAX_PREPARE_ROUNDS) throw new UserFacingError('Plan launch dari API tidak stabil (kedaluwarsa/berubah berulang kali). Coba lagi nanti.');
      await progress({ stage: 'preparing', detail: round > 1 ? `ronde ${round}` : undefined });
      plan = await api.prepareLaunch(request, randomUUID());
      this.assertPlan(plan, chainId);
      const txs = extractTxSteps(plan);
      if (txs.length === 0) throw new UserFacingError('API o1 tidak mengembalikan transaksi untuk ditandatangani.');

      // A step marked "not_run" depends on prerequisites (e.g. an ERC-20 fee approval): send those,
      // then prepare again so the API can simulate the real launch against the new state.
      const deferred = txs.filter((t) => t.simulationNotRun);
      if (deferred.length > 0) {
        for (const tx of txs.filter((t) => !t.simulationNotRun)) {
          await this.sendStep(tx, { policy, kind: 'approval', stage: 'approving', meta: { ...meta, token: plan.predicted_token_address } }, progress);
        }
        continue;
      }

      const expiresAt = Date.parse(plan.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt - this.now() < 5_000) continue; // stale: prepare again

      for (const tx of txs) {
        const isLast = tx === txs[txs.length - 1];
        const sent = await this.sendStep(
          tx,
          { policy, kind: isLast ? 'launch' : 'approval', stage: isLast ? 'sending' : 'approving', meta: { ...meta, token: plan.predicted_token_address } },
          progress,
        );
        if (isLast) launch = sent;
      }
    }

    const token = plan!.predicted_token_address;
    await progress({ stage: 'verifying' });
    const codeVerified = await this.verifyCode(chainId, token);

    const outcome: LaunchOutcome = { chainId, token, launchTx: launch.hash, codeVerified };
    if (draft.devBuy.enabled && draft.devBuy.amountRaw) {
      outcome.devBuy = await this.devBuy(draft, ctx, token, launch.receipt.blockNumber, meta, progress);
    }
    return outcome;
  }

  private assertPlan(plan: LaunchPrepareResult, chainId: number): void {
    if (plan.chain_id !== chainId) throw new UserFacingError(`API mengembalikan plan untuk chain ${plan.chain_id}, bukan ${chainId}.`);
    if (!sameAddress(plan.actor, this.deps.wallet.address)) throw new UserFacingError('Plan dari API ditujukan untuk wallet lain.');
    if (!isAddress(plan.predicted_token_address)) throw new UserFacingError('API tidak mengembalikan alamat token yang valid.');
    const blocking = (plan.issues ?? []).filter((i) => i.severity === 'blocking');
    if (blocking.length > 0) throw new UserFacingError(blocking.map(describeIssue).join('\n'));
  }

  /** Guard, sign, broadcast and wait for one transaction step. The hash is logged before waiting. */
  private async sendStep(tx: ExtractedTx, opts: SendOptions, progress: ProgressFn): Promise<{ hash: Hash; receipt: Receipt }> {
    const { wallet } = this.deps;
    const chainId = opts.meta.chainId;
    const safe = assertTxAllowed(tx.transaction, opts.policy, tx.id);

    await progress({ stage: opts.stage, detail: tx.id });
    const hash = await wallet.send(chainId, safe);
    await this.record({ ...opts.meta, kind: opts.kind, status: 'sent', txHash: hash });
    await progress({ stage: 'confirming', txHash: hash });

    let receipt: Receipt;
    try {
      receipt = await wallet.waitForReceipt(chainId, hash);
    } catch (err) {
      await this.record({ ...opts.meta, kind: opts.kind, status: 'unknown', txHash: hash });
      throw new TxUnknownError(
        `Transaksi terkirim tetapi belum terkonfirmasi dalam batas waktu (${describeError(err).split('\n')[0]}). ` +
          'Cek hash di explorer sebelum mengulang apa pun agar tidak terjadi dobel.',
        hash,
        chainId,
      );
    }
    if (receipt.status !== 'success') {
      await this.record({ ...opts.meta, kind: opts.kind, status: 'reverted', txHash: hash });
      throw new TxRevertedError('Transaksi ter-revert di chain (gas tetap terpakai).', hash, chainId);
    }
    await this.record({ ...opts.meta, kind: opts.kind, status: 'confirmed', txHash: hash });
    return { hash, receipt };
  }

  private async verifyCode(chainId: number, token: Address): Promise<boolean> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        if (await this.deps.wallet.hasCode(chainId, token)) return true;
      } catch (err) {
        this.deps.log.debug('getCode failed', err);
      }
      await this.sleep(1000);
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Dev buy: a normal exact-input swap through the public API after the launch is confirmed.
  // The public API does not expose the atomic `createLaunchAndBuy` path.
  // ---------------------------------------------------------------------------------------------

  private async devBuy(
    draft: Draft,
    ctx: LaunchContext,
    token: Address,
    launchBlock: bigint,
    baseMeta: SendOptions['meta'],
    progress: ProgressFn,
  ): Promise<DevBuyOutcome> {
    const { wallet, api } = this.deps;
    const chainId = draft.chainId;
    const amount = BigInt(draft.devBuy.amountRaw ?? '0');
    const native = isNativeQuote(ctx.quote);
    const policy = guardPolicyFor({
      chainId,
      from: wallet.address,
      suite: ctx.suite,
      quoteAddress: ctx.quote.address,
      maxNativeValue: native ? amount : 0n,
      strict: this.deps.strictTargets,
    });
    const meta = { ...baseMeta, token };
    const approvalTxs: Hash[] = [];
    let swapHash: Hash | undefined;

    try {
      await progress({ stage: 'devbuy-indexing' });
      const indexed = await this.pollUntil(() => api.tokenIndexed(chainId, token), 120_000, 2_000);
      if (!indexed) {
        throw new UserFacingError('Token belum terindeks di API o1 setelah 2 menit, jadi dev buy via API belum bisa dijalankan.');
      }

      if (draft.devBuy.timing === 'auto') await this.waitForAntiSnipe(draft, ctx.suite, launchBlock, progress);

      const quoteRequest: SwapQuoteRequest = {
        chain_id: chainId,
        wallet: wallet.address,
        token_address: token,
        side: 'buy',
        amount_in_raw: amount.toString(),
        slippage_bps: draft.devBuy.slippageBps,
      };

      for (let attempt = 1; !swapHash; attempt++) {
        await progress({ stage: 'devbuy-quoting', detail: attempt > 1 ? `ulang ${attempt}` : undefined });
        const quote = await this.quoteWithRetry(quoteRequest);
        const blocking = (quote.issues ?? []).filter((i) => i.severity === 'blocking');
        if (blocking.length > 0) throw new UserFacingError(blocking.map(describeIssue).join('\n'));

        // Steps of a quote are prerequisites (approvals); the swap itself comes from swaps/prepare.
        for (const step of extractTxSteps(quote).filter((s) => !s.simulationNotRun)) {
          const sent = await this.sendStep(step, { policy, kind: 'approval', stage: 'devbuy-approving', meta }, progress);
          approvalTxs.push(sent.hash);
        }

        let signature: Hex | undefined;
        const typed = extractTypedData(quote);
        if (typed) {
          assertTypedDataAllowed(typed, policy);
          signature = await wallet.signTypedData(chainId, coerceTypedData(typed));
        }

        let prepared;
        try {
          prepared = await api.prepareSwap({ quote_id: quote.quote_id, wallet: wallet.address, permit2_signature: signature });
        } catch (err) {
          const retryable = err instanceof ApiError && ['stale_quote', 'invalid_permit', 'approval_not_confirmed'].includes(err.code);
          if (retryable && attempt < 3) {
            await this.sleep(2000);
            continue;
          }
          throw err;
        }

        const swapSteps = extractTxSteps(prepared);
        if (swapSteps.length === 0) {
          throw new UserFacingError(
            `Respons swaps/prepare tidak berisi transaksi yang dikenali (field: ${Object.keys(prepared).join(', ') || '-'}). Format ini belum terdokumentasi lengkap; lakukan dev buy manual di launch.o1.exchange.`,
          );
        }
        for (const step of swapSteps) {
          const isLast = step === swapSteps[swapSteps.length - 1];
          const sent = await this.sendStep(step, { policy, kind: isLast ? 'devbuy' : 'approval', stage: 'devbuy-sending', meta }, progress);
          if (isLast) swapHash = sent.hash;
        }
      }
      return { status: 'done', txHash: swapHash, approvalTxs };
    } catch (err) {
      this.deps.log.warn(`dev buy failed: ${describeError(err)}`);
      await this.record({ ...meta, kind: 'devbuy', status: 'failed', note: describeError(err).slice(0, 300) });
      const txHash = err instanceof TxRevertedError || err instanceof TxUnknownError ? (err.txHash as Hash) : undefined;
      return { status: 'failed', reason: describeError(err), txHash };
    }
  }

  /** Sleeps until the opening anti-snipe surcharge has decayed (chain time based). */
  private async waitForAntiSnipe(draft: Draft, suite: ContractSuite, launchBlock: bigint, progress: ProgressFn): Promise<void> {
    const window = antiSnipeWindowSeconds(draft, suite);
    if (window <= 0) return;
    const { wallet } = this.deps;
    const launchTs = await wallet.blockTimestamp(draft.chainId, launchBlock);
    const latestTs = await wallet.blockTimestamp(draft.chainId);
    const target = launchTs + window + ANTI_SNIPE_MARGIN_SECONDS;
    const remaining = Math.min(target - latestTs, window + ANTI_SNIPE_MARGIN_SECONDS);
    if (remaining > 0) {
      await progress({ stage: 'devbuy-waiting', detail: String(remaining) });
      await this.sleep(remaining * 1000);
    }
  }

  private async quoteWithRetry(request: SwapQuoteRequest) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.api.quoteSwap(request);
      } catch (err) {
        const transient = err instanceof ApiError && ['quote_unavailable', 'not_found'].includes(err.code);
        if (!transient || attempt >= 8) throw err;
        await this.sleep(3000);
      }
    }
  }

  /** Polls until `check` is true. Only transient API failures are retried; auth errors surface immediately. */
  private async pollUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      try {
        if (await check()) return true;
      } catch (err) {
        const transient = err instanceof ApiError && (err.status === 0 || err.status >= 500);
        if (!transient) throw err;
      }
      if (this.now() >= deadline) return false;
      await this.sleep(intervalMs);
    }
  }

  private async record(entry: Omit<HistoryEntry, 'ts'>): Promise<void> {
    try {
      await this.deps.history.append(entry);
    } catch (err) {
      this.deps.log.error('failed to write history', err);
    }
  }
}

function describeIssue(issue: PlanIssue): string {
  const parts = [issue.detail ?? issue.code];
  if (issue.required_raw !== undefined) parts.push(`(punya ${issue.actual_raw ?? '?'}, butuh ${issue.required_raw})`);
  return parts.join(' ');
}
