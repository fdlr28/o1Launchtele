import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hash, Hex } from 'viem';
import type { O1Api } from '../src/o1/client.js';
import type {
  Configuration,
  LaunchPrepareRequest,
  LaunchPrepareResult,
  Product,
  SwapPrepareRequest,
  SwapPrepareResult,
  SwapQuoteRequest,
  SwapQuoteResult,
} from '../src/o1/types.js';
import type { SafeTx } from '../src/services/guard.js';
import {
  BroadcastRejectedError,
  BroadcastUncertainError,
  type Receipt,
  type SignedTx,
  type TxStatus,
  type TypedDataPayload,
  type Wallet,
} from '../src/wallet/wallet.js';
import { FACTORY, TOKEN, WALLET, configFor } from './fixtures.js';

export const FEE_RAW = '1000000000000000';
export const START_MS = Date.parse('2026-01-01T00:00:00Z');

/** Deterministic clock: sleeping just advances time and is recorded. */
export class FakeClock {
  ms = START_MS;
  sleeps: number[] = [];
  now = () => this.ms;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.ms += ms;
  };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'o1bot-test-'));
}

/** 'replaced': another transaction with the same nonce was mined instead of the one asked for. */
export type ReceiptBehavior = 'success' | 'reverted' | 'timeout' | 'replaced';

/**
 * How the fake network treats one broadcast:
 *  ok               the node accepts the transaction
 *  rejected         the node answers with an error and does not have it
 *  uncertain-landed the reply is lost, but the node did accept the transaction
 *  uncertain-lost   the reply is lost and the node never saw the transaction
 */
export type BroadcastBehavior = 'ok' | 'rejected' | 'uncertain-landed' | 'uncertain-lost';

export interface SentTx {
  chainId: number;
  tx: SafeTx;
  hash: Hash;
}

export class FakeWallet implements Wallet {
  readonly address: Address = WALLET;
  /** Every transaction that was signed, in order. */
  signedTxs: SentTx[] = [];
  /** Every broadcast attempt, whatever its outcome. */
  broadcasts: SentTx[] = [];
  /** Transactions the network actually has (accepted, whether or not the caller heard back). */
  sent: SentTx[] = [];
  signed: TypedDataPayload[] = [];
  /** Consumed per waitForReceipt call; defaults to success. */
  receipts: ReceiptBehavior[] = [];
  /** Consumed per broadcast call; defaults to ok. */
  broadcastBehaviors: BroadcastBehavior[] = [];
  /** Per-hash answers of transactionStatus; accepted transactions default to success, others to unknown. */
  statuses = new Map<Hash, TxStatus>();
  /** Make transactionStatus throw (RPC down). */
  statusError = false;
  /** Transactions of this wallet waiting in the mempool (pending nonce minus confirmed nonce). */
  pendingCount = 0;
  pendingCountError = false;
  statusCalls = 0;
  /** Called inside broadcast() before the network is involved; lets tests inspect what was durable by then. */
  onBroadcast?: (signed: SentTx) => void | Promise<void>;
  /** Thrown by the next sign() call (e.g. a gas estimate that reverts). */
  signError: Error | null = null;
  codeAfterCalls = 0;
  private codeCalls = 0;
  launchTimestamp = 1_000;
  latestTimestamp = 1_004;
  balance = 10n ** 18n;
  quoteBalance = 10n ** 12n;
  chains = [8453];
  private counter = 0;

  enabledChains() {
    return this.chains;
  }
  async nativeBalance() {
    return this.balance;
  }
  async erc20Balance() {
    return this.quoteBalance;
  }
  async sign(chainId: number, tx: SafeTx): Promise<SignedTx> {
    if (this.signError) {
      const err = this.signError;
      this.signError = null;
      throw err;
    }
    this.counter++;
    const hash = `0x${this.counter.toString(16).padStart(64, '0')}` as Hash;
    this.signedTxs.push({ chainId, tx, hash });
    return { hash, raw: `0x02${this.counter.toString(16).padStart(4, '0')}` as Hex };
  }
  async broadcast(chainId: number, signed: SignedTx): Promise<void> {
    const entry = this.signedTxs.find((s) => s.hash === signed.hash);
    if (!entry) throw new Error('FakeWallet: broadcast of a transaction that was never signed here');
    this.broadcasts.push(entry);
    await this.onBroadcast?.(entry);
    const behavior = this.broadcastBehaviors.shift() ?? 'ok';
    if (behavior === 'rejected') throw new BroadcastRejectedError('Node menolak transaksi: nonce too low');
    if (behavior === 'uncertain-lost') throw new BroadcastUncertainError('Hasil pengiriman tidak pasti: timeout');
    this.sent.push({ ...entry, chainId });
    if (behavior === 'uncertain-landed') throw new BroadcastUncertainError('Hasil pengiriman tidak pasti: socket hang up');
  }
  async transactionStatus(_chainId: number, hash: Hash): Promise<TxStatus> {
    this.statusCalls++;
    if (this.statusError) throw new Error('RPC unreachable');
    const forced = this.statuses.get(hash);
    if (forced) return forced;
    return this.sent.some((s) => s.hash === hash) ? 'success' : 'unknown';
  }
  async waitForReceipt(_chainId: number, hash: Hash): Promise<Receipt> {
    const behavior = this.receipts.shift() ?? 'success';
    if (behavior === 'timeout') throw new Error('Timed out while waiting for transaction');
    const transactionHash = behavior === 'replaced' ? (`0x${'ee'.repeat(32)}` as Hash) : hash;
    return { status: behavior === 'reverted' ? 'reverted' : 'success', transactionHash, blockNumber: 500n + BigInt(this.sent.length), gasUsed: 21_000n };
  }
  async pendingTransactionCount(): Promise<number> {
    if (this.pendingCountError) throw new Error('RPC unreachable');
    return this.pendingCount;
  }
  async hasCode() {
    this.codeCalls++;
    return this.codeCalls > this.codeAfterCalls;
  }
  async blockTimestamp(_chainId: number, blockNumber?: bigint) {
    return blockNumber === undefined ? this.latestTimestamp : this.launchTimestamp;
  }
  async signTypedData(_chainId: number, payload: TypedDataPayload): Promise<Hex> {
    this.signed.push(payload);
    return `0x${'ab'.repeat(65)}`;
  }
}

type PlanFactory = (body: LaunchPrepareRequest, call: number) => LaunchPrepareResult;

export function launchPlan(body: LaunchPrepareRequest, nowMs: number, overrides: Partial<LaunchPrepareResult> = {}): LaunchPrepareResult {
  return {
    chain_id: body.chain_id,
    actor: body.creator,
    prepared_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + 30 * 60_000).toISOString(),
    observed_block: '1',
    issues: [],
    steps: [
      {
        id: 'create-launch',
        kind: 'transaction',
        label: 'Create launch',
        depends_on: [],
        transaction: { chain_id: body.chain_id, from: body.creator, to: FACTORY, data: '0xabcdef', value: FEE_RAW },
        simulation: { status: 'succeeded', block_number: '1' },
      },
    ],
    predicted_token_address: TOKEN,
    suite_id: 'test',
    metadata_uri: 'ipfs://meta',
    image_url: null,
    ...overrides,
  };
}

export class FakeApi implements O1Api {
  configs: Partial<Record<Product, Configuration>> = { tax: configFor('tax'), 'non-tax': configFor('non-tax') };
  prepareCalls: Array<{ body: LaunchPrepareRequest; key: string }> = [];
  quoteCalls: SwapQuoteRequest[] = [];
  swapPrepareCalls: SwapPrepareRequest[] = [];
  indexedCalls = 0;
  /** tokenIndexed returns true from this call number on (1-based). */
  indexedFromCall = 1;
  /** Consumed per tokenIndexed call: an entry that is an Error is thrown instead of answering. */
  indexedFaults: Error[] = [];
  planFactory: PlanFactory;
  quoteImpl: (req: SwapQuoteRequest) => Promise<SwapQuoteResult> = async () => ({ quote_id: 'quote-1', issues: [], steps: [] });
  swapPrepareImpl: (req: SwapPrepareRequest) => Promise<SwapPrepareResult> = async () => {
    throw new Error('swapPrepareImpl not set');
  };
  configCalls = 0;

  constructor(private readonly clock: FakeClock) {
    this.planFactory = (body) => launchPlan(body, this.clock.ms);
  }

  async getConfig(_chainId: number, opts: { product: Product }) {
    this.configCalls++;
    const cfg = this.configs[opts.product];
    if (!cfg) throw new Error('no config');
    return structuredClone(cfg);
  }
  async tokenIndexed() {
    this.indexedCalls++;
    const fault = this.indexedFaults.shift();
    if (fault) throw fault;
    return this.indexedCalls >= this.indexedFromCall;
  }
  async prepareLaunch(body: LaunchPrepareRequest, key: string) {
    this.prepareCalls.push({ body, key });
    return this.planFactory(body, this.prepareCalls.length);
  }
  async quoteSwap(req: SwapQuoteRequest) {
    this.quoteCalls.push(req);
    return this.quoteImpl(req);
  }
  async prepareSwap(req: SwapPrepareRequest) {
    this.swapPrepareCalls.push(req);
    return this.swapPrepareImpl(req);
  }
}
