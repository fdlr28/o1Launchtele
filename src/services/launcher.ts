import { randomUUID } from 'node:crypto';
import { isAddress, zeroAddress, type Address, type Hash, type Hex } from 'viem';
import { ANTI_SNIPE_MARGIN_SECONDS, antiSnipeWindowSeconds } from '../domain/devbuy.js';
import type { Draft } from '../domain/draft.js';
import { formatAmount } from '../domain/units.js';
import { TxRevertedError, TxUnknownError, UserFacingError, describeError } from '../errors.js';
import { isNativeQuote, type Catalog } from '../o1/catalog.js';
import { ApiError, type O1Api } from '../o1/client.js';
import { buildLaunchRequest } from '../o1/launchRequest.js';
import { extractTxSteps, extractTypedData, sameAddress, type ExtractedTx } from '../o1/swap.js';
import type { ContractSuite, LaunchPrepareResult, PlanIssue, SwapQuoteRequest } from '../o1/types.js';
import type { Logger } from '../logger.js';
import { BroadcastRejectedError, type Receipt, type TxStatus, type Wallet } from '../wallet/wallet.js';
import { creationFeeCap, resolveLaunchContext, type LaunchContext } from './context.js';
import { assertPlanAllowed, assertTypedDataAllowed, guardPolicyFor, withNeverCall, type CheckedTx, type GuardPolicy } from './guard.js';
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

/** The creation fee as shown in the review. The launch aborts if the live fee is higher or in another currency. */
export interface ReviewedFee {
  /** Zero address = the chain's native currency. */
  currency: Address;
  amountRaw: bigint;
}

export const NO_FEE: ReviewedFee = { currency: zeroAddress, amountRaw: 0n };

/**
 * The o1 contracts that will receive the owner's money, as shown in the review. They come from the o1 API,
 * so the owner gets to see them, and the launch aborts if they differ from what was reviewed.
 */
export interface ReviewedContracts {
  factory: string;
  swapRouter?: string;
  universalRouter?: string;
  permit2?: string;
}

export function contractsOf(suite: ContractSuite): ReviewedContracts {
  const c = suite.contracts;
  const low = (value?: string) => (value ? value.toLowerCase() : undefined);
  return { factory: c.factory.toLowerCase(), swapRouter: low(c.swapx_router), universalRouter: low(c.universal_router), permit2: low(c.permit2) };
}

export function sameContracts(a: ReviewedContracts, b: ReviewedContracts): boolean {
  return a.factory === b.factory && a.swapRouter === b.swapRouter && a.universalRouter === b.universalRouter && a.permit2 === b.permit2;
}

export interface LaunchJob {
  /** A snapshot: later edits of the live draft must not affect a running launch. */
  draft: Draft;
  reviewedFee: ReviewedFee;
  reviewedContracts: ReviewedContracts;
}

export type DevBuyOutcome =
  | { status: 'done'; txHash: Hash; approvalTxs: Hash[] }
  | {
      status: 'failed';
      reason: string;
      txHash?: Hash;
      /** The swap was sent and may still land: the owner must not be told to buy by hand. */
      unknown?: boolean;
    };

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
  /** Contracts the owner explicitly trusts on top of those in /config (EXTRA_ALLOWED_TARGETS). */
  extraTargets?: readonly string[];
  /** Called when a launch that was pending turns out to have confirmed, reverted or vanished. */
  onSettled?: (entry: HistoryEntry, status: 'confirmed' | 'reverted' | 'failed') => void;
  /** Tokens the owner accepts as a creation fee (ALLOWED_FEE_TOKENS). Empty by default: o1 charges native fees. */
  allowedFeeTokens?: readonly string[];
  /** Most a native creation fee may be on a chain (wei). The API's own number is not trusted. Defaults to the chain table. */
  maxCreationFeeWei?: (chainId: number) => bigint | undefined;
  /** Longest one RPC question may take while the history is settled (a hung node must not stall every review). */
  rpcTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A launch that was sent earlier and whose outcome is still unknown blocks the next one. */
export class PendingLaunchError extends UserFacingError {
  constructor(public readonly entries: HistoryEntry[]) {
    super(
      `Ada launch sebelumnya yang hasilnya belum jelas: ${entries.map((e) => `${e.txHash} (chain ${e.chainId})`).join(', ')}. ` +
        'Periksa hash itu di explorer. Kalau transaksinya sudah pasti tidak akan terkonfirmasi, kirim "/dismiss ya" untuk mengabaikannya, lalu coba lagi.',
    );
    this.name = 'PendingLaunchError';
  }
}

/** This draft already produced a launch that is sent or confirmed: launching it again would create a duplicate token. */
export class DraftAlreadyLaunchedError extends UserFacingError {
  constructor(public readonly entry: HistoryEntry) {
    super(
      entry.status === 'confirmed'
        ? `Draft ini sudah berhasil di-launch (tx ${entry.txHash}${entry.token ? `, token ${entry.token}` : ''}). Meluncurkannya lagi akan membuat token kembar. Buat draft baru dengan /launch lalu Reset draft.`
        : `Draft ini sudah punya transaksi launch yang belum jelas hasilnya (tx ${entry.txHash}). Tunggu sampai jelas; jangan meluncurkannya lagi.`,
    );
    this.name = 'DraftAlreadyLaunchedError';
  }
}

const MAX_PREPARE_ROUNDS = 3;
/** A plan is not signed when less than this is left of its lifetime. */
const FRESHNESS_MARGIN_MS = 5_000;
/** Assumed lifetime of a swap plan whose response carries no usable expiry. */
const SWAP_DEFAULT_TTL_MS = 60_000;
/** A second look at the wallet's mempool after this long: a load-balanced node can be a block behind for a moment. */
const IDLE_RECHECK_MS = 3_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const BROADCAST_LOOKUP_ATTEMPTS = 5;
const BROADCAST_LOOKUP_INTERVAL_MS = 3_000;
/** A pending launch that the chain has never heard of after this long is treated as dropped. */
const PENDING_GIVE_UP_MS = 30 * 60_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Meta = Pick<HistoryEntry, 'chainId' | 'product' | 'name' | 'symbol' | 'token' | 'quote'>;

interface SendOptions {
  kind: HistoryEntry['kind'];
  stage: Stage;
  meta: Meta;
}

export class Launcher {
  private busy = false;
  private accepting = true;
  private idleWaiters: Array<() => void> = [];
  /** Settling the history is done one caller at a time: two at once would record (and announce) a result twice. */
  private exclusiveChain: Promise<unknown> = Promise.resolve();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly rpcTimeoutMs: number;
  /** The settle run that is in flight: callers that arrive meanwhile share it instead of queueing their own. */
  private settling: Promise<HistoryEntry[]> | null = null;

  constructor(private readonly deps: LauncherDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.rpcTimeoutMs = deps.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Refuses every new launch from now on and resolves once the running one (if any) is finished, or after
   * `timeoutMs`. True means idle. Used on shutdown so a SIGTERM never cuts a launch in half.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    this.accepting = false;
    if (!this.busy) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      this.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Launches sent earlier whose outcome is still unknown. Those that have meanwhile confirmed, reverted or
   * clearly vanished are settled in the history on the way.
   */
  pendingLaunches(): Promise<HistoryEntry[]> {
    if (!this.settling) {
      const run = this.exclusive(() => this.settlePending());
      this.settling = run.finally(() => {
        this.settling = null;
      });
    }
    return this.settling;
  }

  /** An RPC question with a deadline: a node that never answers counts as "cannot tell", not as a stalled bot. */
  private bounded<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('RPC tidak menjawab tepat waktu')), this.rpcTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const result = this.exclusiveChain.then(job, job);
    this.exclusiveChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async settlePending(): Promise<HistoryEntry[]> {
    const still: HistoryEntry[] = [];
    for (const entry of await this.readHistory(() => this.deps.history.pending())) {
      const txHash = entry.txHash as Hash;
      let status: TxStatus;
      try {
        status = await this.bounded(this.deps.wallet.transactionStatus(entry.chainId, txHash));
      } catch {
        still.push(entry); // the RPC cannot tell us: stay blocked rather than risk a double launch
        continue;
      }
      let settled = false;
      if (status === 'success') settled = await this.settle(entry, 'confirmed', 'settled later');
      else if (status === 'reverted') settled = await this.settle(entry, 'reverted', 'settled later');
      else if (status === 'unknown' && (await this.canGiveUp(entry))) settled = await this.giveUp(entry);
      if (!settled) still.push(entry);
    }
    return still;
  }

  /**
   * A transaction the chain has never heard of may still be sitting in some node's pool, so time alone is not
   * enough: the wallet must also have nothing waiting in the mempool (otherwise the next launch would take
   * the following nonce and BOTH could be mined).
   */
  private async canGiveUp(entry: HistoryEntry): Promise<boolean> {
    if (this.now() - Date.parse(entry.ts) <= PENDING_GIVE_UP_MS) return false;
    try {
      return (await this.bounded(this.deps.wallet.pendingTransactionCount(entry.chainId))) === 0;
    } catch {
      return false;
    }
  }

  /**
   * Nothing of the wallet is waiting and the chain never showed this hash. That still does not mean the launch did
   * not happen: a speed-up made from another client (same nonce, same calldata) executes it under another hash.
   * The token's address is fixed in advance, so code at that address settles the question.
   */
  private async giveUp(entry: HistoryEntry): Promise<boolean> {
    if (!entry.token) return false; // nothing to check against: the owner has to decide (/dismiss)
    let exists: boolean;
    try {
      exists = await this.bounded(this.deps.wallet.hasCode(entry.chainId, entry.token));
    } catch {
      return false;
    }
    return exists
      ? this.settle(entry, 'confirmed', 'the token exists on chain, so the launch ran under another transaction')
      : this.settle(entry, 'failed', 'not found on chain after 30 minutes');
  }

  /** Records the settlement, and only then announces it: an announcement for something not recorded would repeat every minute. */
  private async settle(entry: HistoryEntry, status: 'confirmed' | 'reverted' | 'failed', note: string): Promise<boolean> {
    try {
      await this.deps.history.append(historyBase(entry, status, note));
    } catch (err) {
      this.deps.log.error('failed to record a settlement; it stays pending', err);
      return false;
    }
    try {
      this.deps.onSettled?.({ ...entry, status, note }, status);
    } catch (err) {
      this.deps.log.debug('onSettled callback failed', err);
    }
    return true;
  }

  /** The owner's explicit acknowledgement that the pending launches will never confirm. */
  dismissPending(): Promise<number> {
    return this.exclusive(async () => {
      const pending = await this.readHistory(() => this.deps.history.pending());
      for (const entry of pending) await this.record(historyBase(entry, 'failed', 'dismissed by owner'));
      return pending.length;
    });
  }

  /** A sent or confirmed launch of this very draft, if any. A draft is launched at most once. */
  async priorLaunch(draftId: string): Promise<HistoryEntry | undefined> {
    const entries = await this.readHistory(() => this.deps.history.launchesOfDraft(draftId));
    return entries.find((e) => e.status === 'sent' || e.status === 'unknown' || e.status === 'confirmed');
  }

  /** The history is what stops a second launch: when it cannot be read, nothing is launched. */
  private async readHistory<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      throw new UserFacingError(
        `Riwayat launch tidak bisa dibaca (${describeError(err).split('\n')[0]}), jadi launch diblokir demi keamanan. Periksa folder data (DATA_DIR) lalu coba lagi.`,
        { cause: err },
      );
    }
  }

  /** A transaction of this wallet that is still waiting for a block would be overtaken by (or collide with) a new one. */
  private async assertWalletIdle(chainId: number): Promise<void> {
    let waiting = await this.deps.wallet.pendingTransactionCount(chainId);
    if (waiting > 0) {
      // A load-balanced node can be a block ahead for a moment (our own launch just confirmed): look again once.
      await this.sleep(IDLE_RECHECK_MS);
      waiting = await this.deps.wallet.pendingTransactionCount(chainId);
    }
    if (waiting > 0) {
      throw new UserFacingError(
        `Wallet bot masih punya ${waiting} transaksi yang belum terkonfirmasi di jaringan ini. Tunggu sampai selesai (atau bereskan di explorer), lalu coba lagi.`,
      );
    }
  }

  /** Runs one launch end to end. Only one launch may run at a time (single wallet, single nonce stream). */
  async run(job: LaunchJob, onProgress: ProgressFn = () => {}): Promise<LaunchOutcome> {
    if (!this.accepting) throw new UserFacingError('Bot sedang dimatikan, jadi launch baru tidak diterima.');
    if (this.busy) throw new UserFacingError('Masih ada launch lain yang sedang berjalan. Tunggu sampai selesai.');
    this.busy = true;
    try {
      return await this.execute(job, this.safeProgress(onProgress));
    } finally {
      this.busy = false;
      for (const wake of this.idleWaiters.splice(0)) wake();
    }
  }

  /**
   * Progress reporting must never sit on the money path: a slow or hanging Telegram call could otherwise
   * delay signing until a checked plan has gone stale. So it is fire-and-forget.
   */
  private safeProgress(fn: ProgressFn): ProgressFn {
    return (event) => {
      try {
        const result = fn(event);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => this.deps.log.debug('progress callback failed', err));
        }
      } catch (err) {
        this.deps.log.debug('progress callback failed', err);
      }
    };
  }

  private nowSec = () => Math.floor(this.now() / 1000);

  private async execute(job: LaunchJob, progress: ProgressFn): Promise<LaunchOutcome> {
    const { draft } = job;
    const { wallet, api, catalog } = this.deps;
    const chainId = draft.chainId;

    progress({ stage: 'checking' });
    const pending = await this.pendingLaunches();
    if (pending.length > 0) throw new PendingLaunchError(pending);
    const prior = await this.priorLaunch(draft.id);
    if (prior) throw new DraftAlreadyLaunchedError(prior);
    await this.assertWalletIdle(chainId);

    const ctx = await resolveLaunchContext(catalog, draft, {
      fresh: true,
      tokenDecimals: (token) => wallet.erc20Decimals(chainId, token),
      allowedFeeTokens: new Set((this.deps.allowedFeeTokens ?? []).map((a) => a.toLowerCase())),
    });
    if (!sameContracts(contractsOf(ctx.suite), job.reviewedContracts)) {
      throw new UserFacingError('Alamat kontrak o1 berubah sejak Review. Buka Review lagi, periksa alamatnya, lalu konfirmasi ulang.');
    }
    this.assertFeeWithinCap(ctx, chainId);
    this.assertFeeNotHigher(ctx, job.reviewedFee);
    const feeNative = ctx.fee?.isNative ? ctx.fee.amountRaw : 0n;
    const feeToken = ctx.fee && !ctx.fee.isNative ? ctx.fee : null;

    const request = buildLaunchRequest({ draft, creator: wallet.address, suite: ctx.suite, quote: ctx.quote });
    const policy = guardPolicyFor({
      chainId,
      from: wallet.address,
      suite: ctx.suite,
      kind: 'launch',
      // A launch needs no allowance for the pair; the only ERC-20 it may touch is an ERC-20 creation fee.
      erc20: feeToken ? [{ address: feeToken.currency, maxApprove: feeToken.amountRaw, maxPermit: 0n }] : [],
      neverCall: [ctx.quote.address],
      maxTotalNativeValue: feeNative,
      extraTargets: this.deps.extraTargets,
      nowSec: this.nowSec,
    });
    const baseMeta = { chainId, product: draft.product, draftId: draft.id, name: draft.name ?? undefined, symbol: draft.symbol ?? undefined, quote: ctx.quote.address };

    const sentApprovals = new Set<string>();
    let plan: LaunchPrepareResult | undefined;
    let launch: { hash: Hash; receipt: Receipt } | undefined;

    for (let round = 1; !launch; round++) {
      if (round > MAX_PREPARE_ROUNDS) throw new UserFacingError('Plan launch dari API tidak stabil (kedaluwarsa/berubah berulang kali). Coba lagi nanti.');
      progress({ stage: 'preparing', detail: round > 1 ? `ronde ${round}` : undefined });
      plan = await api.prepareLaunch(request, randomUUID());
      const receivedAt = this.now();
      this.assertPlan(plan, chainId);

      const steps = extractTxSteps(plan);
      if (steps.length === 0) throw new UserFacingError('API o1 tidak mengembalikan transaksi untuk ditandatangani.');
      // Judge the WHOLE plan before signing anything: a bad step must not be discovered after earlier ones were sent.
      // The token this plan is about to create is one more thing that can only be approved, never called.
      const checked = assertPlanAllowed(
        steps.map((s) => ({ id: s.id, transaction: s.transaction })),
        withNeverCall(policy, [plan.predicted_token_address]),
        { finalCall: true },
      );
      await this.assertNotTokens(chainId, checked);
      if (steps.slice(0, -1).some((s) => s.simulationNotRun)) {
        throw new UserFacingError('Urutan langkah dari API tidak dikenali (prasyarat ditandai belum disimulasikan).');
      }
      const deadline = this.planDeadline(plan, receivedAt);
      const meta = { ...baseMeta, token: plan.predicted_token_address };

      // Prerequisites (ERC-20 fee approvals) first. A plan that goes stale midway is prepared again.
      let stale = false;
      for (let i = 0; i < steps.length - 1; i++) {
        const key = approvalKey(checked[i] as CheckedTx);
        if (sentApprovals.has(key)) continue;
        if (!this.isFresh(deadline)) {
          stale = true;
          break;
        }
        await this.sendStep(steps[i] as ExtractedTx, checked[i] as CheckedTx, { kind: 'approval', stage: 'approving', meta }, progress);
        sentApprovals.add(key);
      }
      if (stale) continue;

      const last = steps[steps.length - 1] as ExtractedTx;
      if (last.simulationNotRun) {
        // The launch could not be simulated before its prerequisites existed: prepare again now that they do.
        if (steps.length === 1) throw new UserFacingError('API menandai langkah launch belum disimulasikan tanpa prasyarat apa pun.');
        continue;
      }
      if (!this.isFresh(deadline)) continue;
      launch = await this.sendStep(last, checked[steps.length - 1] as CheckedTx, { kind: 'launch', stage: 'sending', meta }, progress);
    }

    // From here on the launch is done and paid for. Nothing below may turn it into an error: a thrown exception
    // would tell the owner "launch failed" and invite a second one.
    const token = (plan as LaunchPrepareResult).predicted_token_address;
    const outcome: LaunchOutcome = { chainId, token, launchTx: launch.hash, codeVerified: false };
    try {
      progress({ stage: 'verifying' });
      outcome.codeVerified = await this.verifyCode(chainId, token);
    } catch (err) {
      this.deps.log.warn('token code verification failed', err);
    }
    if (draft.devBuy.enabled && draft.devBuy.amountRaw) {
      try {
        outcome.devBuy = await this.devBuy(draft, ctx, token, launch.receipt.blockNumber, baseMeta, progress);
      } catch (err) {
        this.deps.log.warn('dev buy crashed', err);
        outcome.devBuy = { status: 'failed', reason: describeError(err) };
      }
    }
    return outcome;
  }

  /** An absolute ceiling on a native creation fee, independent of anything the API says about its own numbers. */
  private assertFeeWithinCap(ctx: LaunchContext, chainId: number): void {
    if (!ctx.fee?.isNative) return;
    const cap = creationFeeCap(chainId, this.deps.maxCreationFeeWei);
    if (ctx.fee.amountRaw > cap) {
      throw new UserFacingError(
        `Creation fee ${formatAmount(ctx.fee.amountRaw, ctx.nativeDecimals)} ${ctx.nativeSymbol} melebihi batas keamanan bot (${formatAmount(cap, ctx.nativeDecimals)} ${ctx.nativeSymbol}). ` +
          `Kalau o1 memang menaikkan fee, naikkan batasnya dengan MAX_CREATION_FEE_${chainId} di .env setelah kamu memverifikasinya.`,
      );
    }
  }

  /**
   * A call may only go to the factory or a router, never to a token. The guard already refuses the tokens of the
   * plan and every token-moving function; this asks the chain as well, because a hostile /config could call any
   * token the wallet happens to hold (a stablecoin from claimed fees, the tokens of an earlier dev buy).
   */
  private async assertNotTokens(chainId: number, checked: CheckedTx[]): Promise<void> {
    const vouched = new Set((this.deps.extraTargets ?? []).map((a) => a.toLowerCase()));
    for (const tx of checked) {
      if (tx.kind !== 'call' || vouched.has(tx.to.toLowerCase())) continue;
      if (await this.deps.wallet.isTokenLike(chainId, tx.to)) {
        throw new UserFacingError(
          `Transaksi ditolak demi keamanan: ${tx.to} menjawab seperti kontrak token (ERC-20), bukan factory atau router. ` +
            'Kalau ini memang kontrak o1 yang sah, daftarkan alamatnya di EXTRA_ALLOWED_TARGETS setelah kamu memverifikasinya.',
        );
      }
    }
  }

  /** The launch aborts if the live fee is higher than, or in another currency than, the one the owner reviewed. */
  private assertFeeNotHigher(ctx: LaunchContext, reviewed: ReviewedFee): void {
    const live = ctx.fee ? { currency: ctx.fee.currency, amountRaw: ctx.fee.amountRaw } : NO_FEE;
    if (!sameAddress(live.currency, reviewed.currency)) {
      throw new UserFacingError('Mata uang creation fee berubah sejak Review. Buka Review lagi lalu konfirmasi ulang.');
    }
    if (live.amountRaw > reviewed.amountRaw) {
      const decimals = ctx.fee?.decimals ?? ctx.nativeDecimals;
      const symbol = ctx.fee?.symbol ?? ctx.nativeSymbol;
      throw new UserFacingError(
        `Fee launch naik menjadi ${formatAmount(live.amountRaw, decimals)} ${symbol} ` +
          `(saat review: ${formatAmount(reviewed.amountRaw, decimals)}). Buka Review lagi lalu konfirmasi ulang.`,
      );
    }
  }

  private assertPlan(plan: LaunchPrepareResult, chainId: number): void {
    if (plan.chain_id !== chainId) throw new UserFacingError(`API mengembalikan plan untuk chain ${plan.chain_id}, bukan ${chainId}.`);
    if (!sameAddress(plan.actor, this.deps.wallet.address)) throw new UserFacingError('Plan dari API ditujukan untuk wallet lain.');
    if (!isAddress(plan.predicted_token_address)) throw new UserFacingError('API tidak mengembalikan alamat token yang valid.');
    const blocking = (plan.issues ?? []).filter((i) => i.severity === 'blocking');
    if (blocking.length > 0) throw new UserFacingError(blocking.map(describeIssue).join('\n'));
  }

  /**
   * Local deadline of a plan. The lifetime is measured as expires_at - prepared_at (both from the API) and
   * counted from the moment we received the plan, so a skewed local clock cannot make a stale plan look fresh.
   * A missing or garbled expiry fails closed.
   */
  private planDeadline(plan: { prepared_at?: string; expires_at?: string }, receivedAtMs: number): number {
    const expires = Date.parse(plan.expires_at ?? '');
    const prepared = Date.parse(plan.prepared_at ?? '');
    let deadline = Number.NaN;
    if (Number.isFinite(expires) && Number.isFinite(prepared) && expires > prepared) deadline = receivedAtMs + (expires - prepared);
    else if (Number.isFinite(expires)) deadline = expires;
    if (!Number.isFinite(deadline)) {
      throw new UserFacingError('Plan dari API tidak memiliki waktu kedaluwarsa yang valid, jadi dibatalkan demi keamanan.');
    }
    return deadline;
  }

  private isFresh(deadlineMs: number): boolean {
    return this.now() < deadlineMs - FRESHNESS_MARGIN_MS;
  }

  /**
   * Signs, records, broadcasts and confirms one already-validated step. The hash is written to the history
   * BEFORE the broadcast, and an unclear broadcast outcome is settled by looking the hash up on chain, so a
   * lost reply can never end in a second launch.
   */
  private async sendStep(step: ExtractedTx, safe: CheckedTx, opts: SendOptions, progress: ProgressFn): Promise<{ hash: Hash; receipt: Receipt }> {
    const { wallet } = this.deps;
    const chainId = opts.meta.chainId;

    progress({ stage: opts.stage, detail: step.id });
    const signed = await wallet.sign(chainId, { to: safe.to, data: safe.data, value: safe.value });
    // Write-ahead: the hash must be durable BEFORE the transaction can reach the network. If it cannot be
    // written, nothing is sent, because a crash after the broadcast would otherwise leave an untracked launch.
    await this.recordBeforeSend({ ...opts.meta, kind: opts.kind, status: 'sent', txHash: signed.hash });

    try {
      await wallet.broadcast(chainId, signed);
    } catch (err) {
      const rejected = err instanceof BroadcastRejectedError;
      const status = await this.lookupStatus(chainId, signed.hash, rejected ? 1 : BROADCAST_LOOKUP_ATTEMPTS);
      if (status === 'unknown') {
        if (rejected) {
          await this.record({ ...opts.meta, kind: opts.kind, status: 'failed', txHash: signed.hash, note: describeError(err).slice(0, 200) });
          throw err;
        }
        await this.record({ ...opts.meta, kind: opts.kind, status: 'unknown', txHash: signed.hash, note: 'broadcast outcome unknown' });
        throw new TxUnknownError(
          'Transaksi sudah ditandatangani dan dikirim, tetapi jawaban node hilang dan hash-nya belum terlihat di chain. ' +
            'Cek hash di explorer sebelum melakukan apa pun agar tidak terjadi dobel.',
          signed.hash,
          chainId,
        );
      }
      // The node has the transaction after all (pending or already mined): carry on and wait for the receipt.
      this.deps.log.warn(`broadcast reply was unclear but ${signed.hash} is on chain (${status})`);
    }

    progress({ stage: 'confirming', txHash: signed.hash });
    let receipt: Receipt;
    try {
      receipt = await wallet.waitForReceipt(chainId, signed.hash);
    } catch (err) {
      await this.record({ ...opts.meta, kind: opts.kind, status: 'unknown', txHash: signed.hash });
      throw new TxUnknownError(
        `Transaksi terkirim tetapi belum terkonfirmasi dalam batas waktu (${describeError(err).split('\n')[0]}). ` +
          'Cek hash di explorer sebelum mengulang apa pun agar tidak terjadi dobel.',
        signed.hash,
        chainId,
      );
    }
    if (receipt.transactionHash.toLowerCase() !== signed.hash.toLowerCase()) {
      // Another transaction with the same nonce was mined instead (a cancel or speed-up made elsewhere). Ours did
      // not run, but the replacement may have done the very same launch, so nothing is assumed.
      await this.record({ ...opts.meta, kind: opts.kind, status: 'unknown', txHash: signed.hash, note: `replaced by ${receipt.transactionHash}` });
      throw new TxUnknownError(
        `Transaksi ini digantikan oleh transaksi lain dengan nonce yang sama (${receipt.transactionHash}). ` +
          'Cek keduanya di explorer sebelum melakukan apa pun agar tidak terjadi dobel.',
        signed.hash,
        chainId,
      );
    }
    if (receipt.status !== 'success') {
      await this.record({ ...opts.meta, kind: opts.kind, status: 'reverted', txHash: signed.hash });
      throw new TxRevertedError('Transaksi ter-revert di chain (gas tetap terpakai).', signed.hash, chainId);
    }
    await this.record({ ...opts.meta, kind: opts.kind, status: 'confirmed', txHash: signed.hash });
    return { hash: signed.hash, receipt };
  }

  private async lookupStatus(chainId: number, hash: Hash, attempts: number): Promise<TxStatus> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const status = await this.deps.wallet.transactionStatus(chainId, hash);
        if (status !== 'unknown') return status;
      } catch (err) {
        this.deps.log.debug('transaction status lookup failed', err);
      }
      if (attempt < attempts) await this.sleep(BROADCAST_LOOKUP_INTERVAL_MS);
    }
    return 'unknown';
  }

  private async verifyCode(chainId: number, token: Address): Promise<boolean> {
    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        if (await this.deps.wallet.hasCode(chainId, token)) return true;
      } catch (err) {
        this.deps.log.debug('getCode failed', err);
      }
      if (attempt < attempts) await this.sleep(1000);
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
    baseMeta: Meta,
    progress: ProgressFn,
  ): Promise<DevBuyOutcome> {
    const { wallet, api } = this.deps;
    const chainId = draft.chainId;
    const amount = BigInt(draft.devBuy.amountRaw ?? '0');
    const native = isNativeQuote(ctx.quote);
    // Worst case is bounded by what the owner reviewed: the native value, every allowance and every permit
    // may cover at most the dev buy amount.
    const policy = guardPolicyFor({
      chainId,
      from: wallet.address,
      suite: ctx.suite,
      kind: 'swap',
      // The pair is the only token a buy pays with; its allowance and permit may cover at most the dev buy.
      erc20: native ? [] : [{ address: ctx.quote.address, maxApprove: amount, maxPermit: amount }],
      neverCall: [ctx.quote.address, token],
      maxTotalNativeValue: native ? amount : 0n,
      extraTargets: this.deps.extraTargets,
      nowSec: this.nowSec,
    });
    const meta = { ...baseMeta, token };
    const sentApprovals = new Set<string>();
    const approvalTxs: Hash[] = [];
    let swapHash: Hash | undefined;

    try {
      progress({ stage: 'devbuy-indexing' });
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
        if (attempt > 3) throw new UserFacingError('Quote swap tidak stabil (berulang kali kedaluwarsa). Coba beli manual di launch.o1.exchange.');
        progress({ stage: 'devbuy-quoting', detail: attempt > 1 ? `ulang ${attempt}` : undefined });
        const quote = await this.quoteWithRetry(quoteRequest);
        const blocking = (quote.issues ?? []).filter((i) => i.severity === 'blocking');
        if (blocking.length > 0) throw new UserFacingError(blocking.map(describeIssue).join('\n'));

        // The steps of a quote are prerequisites only. A swap smuggled into a quote would be sent twice.
        const quoteSteps = extractTxSteps(quote);
        if (quoteSteps.length > 0) {
          const checked = assertPlanAllowed(quoteSteps.map((s) => ({ id: s.id, transaction: s.transaction })), policy, { finalCall: false });
          for (const [i, step] of quoteSteps.entries()) {
            const safe = checked[i] as CheckedTx;
            const key = approvalKey(safe);
            if (sentApprovals.has(key)) continue;
            const sent = await this.sendStep(step, safe, { kind: 'approval', stage: 'devbuy-approving', meta }, progress);
            sentApprovals.add(key);
            approvalTxs.push(sent.hash);
          }
        }

        let signature: Hex | undefined;
        const typed = extractTypedData(quote);
        if (typed) {
          // What is signed is the payload rebuilt from the validated fields, not the API's own object.
          signature = await wallet.signTypedData(chainId, assertTypedDataAllowed(typed, policy));
        }

        let prepared;
        try {
          prepared = await api.prepareSwap({ quote_id: quote.quote_id, wallet: wallet.address, permit2_signature: signature });
        } catch (err) {
          const retryable = err instanceof ApiError && ['stale_quote', 'invalid_permit', 'approval_not_confirmed'].includes(err.code);
          if (retryable) {
            await this.sleep(2000);
            continue;
          }
          throw err;
        }
        const receivedAt = this.now();

        const swapSteps = extractTxSteps(prepared);
        if (swapSteps.length === 0) {
          throw new UserFacingError(
            `Respons swaps/prepare tidak berisi transaksi yang dikenali (field: ${Object.keys(prepared).join(', ') || '-'}). Format ini belum terdokumentasi lengkap; lakukan dev buy manual di launch.o1.exchange.`,
          );
        }
        const checked = assertPlanAllowed(swapSteps.map((s) => ({ id: s.id, transaction: s.transaction })), policy, { finalCall: true });
        await this.assertNotTokens(chainId, checked);
        const deadline = this.swapDeadline(prepared, receivedAt);

        let stale = false;
        for (const [i, step] of swapSteps.entries()) {
          const safe = checked[i] as CheckedTx;
          const isLast = i === swapSteps.length - 1;
          if (!isLast && sentApprovals.has(approvalKey(safe))) continue;
          if (!this.isFresh(deadline)) {
            stale = true;
            break;
          }
          const sent = await this.sendStep(step, safe, { kind: isLast ? 'devbuy' : 'approval', stage: 'devbuy-sending', meta }, progress);
          if (isLast) swapHash = sent.hash;
          else sentApprovals.add(approvalKey(safe));
        }
        if (stale) continue; // quote again
      }
      return { status: 'done', txHash: swapHash, approvalTxs };
    } catch (err) {
      this.deps.log.warn(`dev buy failed: ${describeError(err)}`);
      await this.record({ ...meta, kind: 'devbuy', status: 'failed', note: describeError(err).slice(0, 300) });
      const txHash = err instanceof TxRevertedError || err instanceof TxUnknownError ? (err.txHash as Hash) : undefined;
      return { status: 'failed', reason: describeError(err), txHash, unknown: err instanceof TxUnknownError };
    }
  }

  /** Swap plans may carry an expiry; when they do not, assume a short lifetime from the moment we got them. */
  private swapDeadline(prepared: { expires_at?: unknown; prepared_at?: unknown }, receivedAtMs: number): number {
    const expires = typeof prepared.expires_at === 'string' ? Date.parse(prepared.expires_at) : Number.NaN;
    const preparedAt = typeof prepared.prepared_at === 'string' ? Date.parse(prepared.prepared_at) : Number.NaN;
    if (Number.isFinite(expires) && Number.isFinite(preparedAt) && expires > preparedAt) return receivedAtMs + (expires - preparedAt);
    if (Number.isFinite(expires)) return Math.min(expires, receivedAtMs + 10 * 60_000);
    return receivedAtMs + SWAP_DEFAULT_TTL_MS;
  }

  /** Sleeps until the opening anti-snipe surcharge has decayed (chain time based, bounded). */
  private async waitForAntiSnipe(draft: Draft, suite: ContractSuite, launchBlock: bigint, progress: ProgressFn): Promise<void> {
    const window = antiSnipeWindowSeconds(draft, suite);
    if (window <= 0) return;
    const { wallet } = this.deps;
    const launchTs = await wallet.blockTimestamp(draft.chainId, launchBlock);
    const latestTs = await wallet.blockTimestamp(draft.chainId);
    const target = launchTs + window + ANTI_SNIPE_MARGIN_SECONDS;
    const remaining = Math.min(target - latestTs, window + ANTI_SNIPE_MARGIN_SECONDS);
    if (remaining > 0) {
      progress({ stage: 'devbuy-waiting', detail: String(remaining) });
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
        const transient = err instanceof ApiError && (err.status === 0 || err.status === 429 || err.status >= 500);
        if (!transient) throw err;
      }
      if (this.now() >= deadline) return false;
      await this.sleep(intervalMs);
    }
  }

  /** Best effort: used for outcomes, where losing a line is bad but no longer dangerous. */
  private async record(entry: Omit<HistoryEntry, 'ts'>): Promise<void> {
    try {
      await this.deps.history.append(entry);
    } catch (err) {
      this.deps.log.error('failed to write history', err);
    }
  }

  /** Mandatory: the caller must not broadcast when this throws. */
  private async recordBeforeSend(entry: Omit<HistoryEntry, 'ts'>): Promise<void> {
    try {
      await this.deps.history.append(entry);
    } catch (err) {
      this.deps.log.error('failed to write history before sending', err);
      throw new UserFacingError(
        `Riwayat transaksi tidak bisa ditulis (${describeError(err).split('\n')[0]}), jadi transaksi TIDAK dikirim. Periksa disk/izin folder data lalu coba lagi.`,
        { cause: err },
      );
    }
  }
}

/** The history record that settles `entry` with a new status, keeping everything that identifies it. */
function historyBase(entry: HistoryEntry, status: HistoryEntry['status'], note: string): Omit<HistoryEntry, 'ts'> {
  return {
    kind: 'launch',
    status,
    chainId: entry.chainId,
    product: entry.product,
    draftId: entry.draftId,
    name: entry.name,
    symbol: entry.symbol,
    token: entry.token,
    quote: entry.quote,
    txHash: entry.txHash,
    note,
  };
}

function approvalKey(tx: CheckedTx): string {
  return `${tx.to}:${tx.data}`.toLowerCase();
}

function describeIssue(issue: PlanIssue): string {
  const parts = [issue.detail ?? issue.code];
  if (issue.required_raw !== undefined) parts.push(`(punya ${issue.actual_raw ?? '?'}, butuh ${issue.required_raw})`);
  return parts.join(' ');
}

export type { GuardPolicy };
