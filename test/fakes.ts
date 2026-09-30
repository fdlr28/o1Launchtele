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
import type { Receipt, TypedDataPayload, Wallet } from '../src/wallet/wallet.js';
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

export type ReceiptBehavior = 'success' | 'reverted' | 'timeout';

export class FakeWallet implements Wallet {
  readonly address: Address = WALLET;
  sent: Array<{ chainId: number; tx: SafeTx; hash: Hash }> = [];
  signed: TypedDataPayload[] = [];
  /** Consumed per waitForReceipt call; defaults to success. */
  receipts: ReceiptBehavior[] = [];
  codeAfterCalls = 0;
  private codeCalls = 0;
  launchTimestamp = 1_000;
  latestTimestamp = 1_004;
  balance = 10n ** 18n;
  quoteBalance = 10n ** 12n;
  private counter = 0;

  enabledChains() {
    return [8453];
  }
  async nativeBalance() {
    return this.balance;
  }
  async erc20Balance() {
    return this.quoteBalance;
  }
  async send(chainId: number, tx: SafeTx): Promise<Hash> {
    this.counter++;
    const hash = `0x${this.counter.toString(16).padStart(64, '0')}` as Hash;
    this.sent.push({ chainId, tx, hash });
    return hash;
  }
  async waitForReceipt(_chainId: number, _hash: Hash): Promise<Receipt> {
    const behavior = this.receipts.shift() ?? 'success';
    if (behavior === 'timeout') throw new Error('Timed out while waiting for transaction');
    return { status: behavior, blockNumber: 500n + BigInt(this.sent.length), gasUsed: 21_000n };
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
