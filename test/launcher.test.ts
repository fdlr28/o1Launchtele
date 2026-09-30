import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, erc20Abi } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { newDraft, type Draft } from '../src/domain/draft.js';
import { validateImage } from '../src/domain/validators.js';
import { TxRevertedError, TxUnknownError } from '../src/errors.js';
import { silentLogger } from '../src/logger.js';
import { Catalog } from '../src/o1/catalog.js';
import { ApiError } from '../src/o1/client.js';
import { Launcher, type LaunchJob, type ProgressEvent } from '../src/services/launcher.js';
import { History } from '../src/services/history.js';
import { FEE_RAW, FakeApi, FakeClock, FakeWallet, launchPlan, tempDir } from './fakes.js';
import { AAPL, FACTORY, ROUTER, TOKEN, USDC, WALLET, ZERO, addr, configFor } from './fixtures.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const approve = (token: string, spender: `0x${string}`) => ({
  to: token as `0x${string}`,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 5n] }),
});

function draftWith(overrides: Partial<Draft> = {}): Draft {
  return {
    ...newDraft({ chainId: 8453, wallet: WALLET }),
    quote: { address: ZERO, symbol: 'ETH', decimals: 18, route: 'standard', assetType: 'native' },
    name: 'Pepe Coin',
    symbol: 'PEPE',
    image: validateImage(PNG),
    ...overrides,
  };
}

let clock: FakeClock;
let api: FakeApi;
let wallet: FakeWallet;
let dir: string;
let events: ProgressEvent[];
let launcher: Launcher;

function job(draft = draftWith(), reviewedFeeRaw = BigInt(FEE_RAW)): LaunchJob {
  return { draft, reviewedFeeRaw };
}

const run = (j = job()) => launcher.run(j, (e) => void events.push(e));

beforeEach(() => {
  clock = new FakeClock();
  api = new FakeApi(clock);
  wallet = new FakeWallet();
  dir = tempDir();
  events = [];
  launcher = new Launcher({
    api,
    catalog: new Catalog(api),
    wallet,
    history: new History(dir),
    log: silentLogger,
    strictTargets: true,
    sleep: clock.sleep,
    now: clock.now,
  });
});

const historyLines = () =>
  readFileSync(join(dir, 'launches.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

describe('happy path', () => {
  it('prepares, sends exactly the API transaction, confirms and verifies the token', async () => {
    const outcome = await run();

    expect(outcome).toMatchObject({ chainId: 8453, token: TOKEN, codeVerified: true });
    expect(outcome.devBuy).toBeUndefined();

    // one prepare call with a Tax request built from the draft
    expect(api.prepareCalls).toHaveLength(1);
    const { body, key } = api.prepareCalls[0]!;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toMatchObject({ chain_id: 8453, creator: WALLET, launch_product: 'tax', market: 'standard', quote_address: ZERO });
    expect(body.token.name).toBe('Pepe Coin');

    // one transaction, unchanged from the plan
    expect(wallet.sent).toHaveLength(1);
    expect(wallet.sent[0]?.tx).toEqual({ to: FACTORY, data: '0xabcdef', value: BigInt(FEE_RAW) });
    expect(outcome.launchTx).toBe(wallet.sent[0]?.hash);

    expect(events.map((e) => e.stage)).toEqual(['checking', 'preparing', 'sending', 'confirming', 'verifying']);
  });

  it('writes the hash to history before waiting, then confirms it', async () => {
    await run();
    const lines = historyLines();
    expect(lines.map((l) => [l.kind, l.status])).toEqual([
      ['launch', 'sent'],
      ['launch', 'confirmed'],
    ]);
    expect(lines[0]).toMatchObject({ chainId: 8453, name: 'Pepe Coin', symbol: 'PEPE', token: TOKEN, product: 'tax' });
    const recent = await new History(dir).recent('launch', 5);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ status: 'confirmed', token: TOKEN });
  });

  it('retries the code check when the RPC lags, and flags an unverified token', async () => {
    wallet.codeAfterCalls = 2;
    expect((await run()).codeVerified).toBe(true);
    wallet.codeAfterCalls = 99;
    const second = await launcher.run(job(), () => {});
    expect(second.codeVerified).toBe(false);
  });
});

describe('safety checks before signing', () => {
  it('aborts when the live fee is higher than the fee the user reviewed', async () => {
    await expect(run(job(draftWith(), BigInt(FEE_RAW) - 1n))).rejects.toThrow(/Fee launch naik/);
    expect(api.prepareCalls).toHaveLength(0);
    expect(wallet.sent).toHaveLength(0);
  });

  it('refuses a plan whose transaction targets an unknown contract', async () => {
    api.planFactory = (body) => {
      const plan = launchPlan(body, clock.ms);
      (plan.steps[0] as { transaction: { to: string } }).transaction.to = addr(0xbad);
      return plan;
    };
    await expect(run()).rejects.toThrow(/ditolak demi keamanan/);
    expect(wallet.sent).toHaveLength(0);
  });

  it('refuses a plan that asks for more value than the reviewed fee', async () => {
    api.planFactory = (body) => {
      const plan = launchPlan(body, clock.ms);
      (plan.steps[0] as { transaction: { value: string } }).transaction.value = (BigInt(FEE_RAW) * 2n).toString();
      return plan;
    };
    await expect(run()).rejects.toThrow(/melebihi/);
    expect(wallet.sent).toHaveLength(0);
  });

  it('refuses a plan for another wallet, another chain, or with blocking issues', async () => {
    api.planFactory = (body) => launchPlan(body, clock.ms, { actor: addr(0xbad) });
    await expect(run()).rejects.toThrow(/wallet lain/);
    api.planFactory = (body) => launchPlan(body, clock.ms, { chain_id: 56 });
    await expect(run()).rejects.toThrow(/chain 56/);
    api.planFactory = (body) =>
      launchPlan(body, clock.ms, { issues: [{ code: 'insufficient_balance', severity: 'blocking', detail: 'Saldo kurang', actual_raw: '1', required_raw: '2' }] });
    await expect(run()).rejects.toThrow(/Saldo kurang/);
    expect(wallet.sent).toHaveLength(0);
  });

  it('refuses an empty plan', async () => {
    api.planFactory = (body) => launchPlan(body, clock.ms, { steps: [] });
    await expect(run()).rejects.toThrow(/tidak mengembalikan transaksi/);
  });
});

describe('transaction outcomes', () => {
  it('reports a reverted launch with its hash and skips the dev buy', async () => {
    wallet.receipts = ['reverted'];
    const draft = draftWith();
    draft.devBuy = { ...draft.devBuy, enabled: true, amountRaw: '1000' };
    const err = await run(job(draft, BigInt(FEE_RAW))).catch((e) => e);
    expect(err).toBeInstanceOf(TxRevertedError);
    expect(err.txHash).toBe(wallet.sent[0]?.hash);
    expect(api.indexedCalls).toBe(0);
    expect(historyLines().map((l) => l.status)).toEqual(['sent', 'reverted']);
  });

  it('reports an unconfirmed launch as unknown and never resends', async () => {
    wallet.receipts = ['timeout'];
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(TxUnknownError);
    expect(err.message).toMatch(/explorer/);
    expect(wallet.sent).toHaveLength(1);
    expect(historyLines().map((l) => l.status)).toEqual(['sent', 'unknown']);
  });

  it('prepares again when the plan is about to expire', async () => {
    api.planFactory = (body, call) =>
      call === 1 ? launchPlan(body, clock.ms, { expires_at: new Date(clock.ms + 1_000).toISOString() }) : launchPlan(body, clock.ms);
    await run();
    expect(api.prepareCalls).toHaveLength(2);
    expect(api.prepareCalls[0]?.key).not.toBe(api.prepareCalls[1]?.key);
    expect(wallet.sent).toHaveLength(1);
  });

  it('gives up if the API keeps returning stale plans', async () => {
    api.planFactory = (body) => launchPlan(body, clock.ms, { expires_at: new Date(clock.ms - 1).toISOString() });
    await expect(run()).rejects.toThrow(/tidak stabil/);
    expect(api.prepareCalls).toHaveLength(3);
    expect(wallet.sent).toHaveLength(0);
  });

  it('sends an ERC-20 fee approval first when the launch step is not_run, then prepares again', async () => {
    const cfg = configFor('tax');
    cfg.suites![0]!.creation_fee = { amount_raw: '5', currency: USDC, symbol: 'USDC', decimals: 6 };
    api.configs.tax = cfg;
    api.planFactory = (body, call) => {
      if (call > 1) {
        return launchPlan(body, clock.ms, {
          steps: [
            {
              id: 'create-launch', kind: 'transaction', label: 'Create', depends_on: [],
              transaction: { chain_id: 8453, from: WALLET, to: FACTORY, data: '0xabcdef', value: '0' },
              simulation: { status: 'succeeded' },
            },
          ],
        });
      }
      return launchPlan(body, clock.ms, {
        steps: [
          {
            id: 'approve-fee', kind: 'transaction', label: 'Approve', depends_on: [],
            transaction: { chain_id: 8453, from: WALLET, ...approve(USDC, FACTORY), value: '0' },
            simulation: { status: 'succeeded' },
          },
          {
            id: 'create-launch', kind: 'transaction', label: 'Create', depends_on: ['approve-fee'],
            transaction: { chain_id: 8453, from: WALLET, to: FACTORY, data: '0xabcdef', value: '0' },
            simulation: { status: 'not_run' },
          },
        ],
      });
    };
    const outcome = await run(job(draftWith(), 0n));
    expect(api.prepareCalls).toHaveLength(2);
    expect(wallet.sent.map((s) => s.tx.to)).toEqual([USDC, FACTORY]);
    expect(outcome.launchTx).toBe(wallet.sent[1]?.hash);
    expect(historyLines().map((l) => l.kind)).toEqual(['approval', 'approval', 'launch', 'launch']);
  });
});

describe('concurrency', () => {
  it('runs one launch at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = api.prepareLaunch.bind(api);
    api.prepareLaunch = async (body, key) => {
      await gate;
      return original(body, key);
    };
    const first = run();
    await Promise.resolve();
    expect(launcher.isBusy()).toBe(true);
    await expect(run()).rejects.toThrow(/sedang berjalan/);
    release();
    await first;
    expect(launcher.isBusy()).toBe(false);
    await expect(run()).resolves.toBeDefined(); // usable again
  });

  it('frees the lock after a failure', async () => {
    api.planFactory = (body) => launchPlan(body, clock.ms, { steps: [] });
    await expect(run()).rejects.toThrow();
    expect(launcher.isBusy()).toBe(false);
  });
});

describe('dev buy (follow-up swap through the public API)', () => {
  const swapPlan = (value: string, to = ROUTER, chainId = 8453) => ({
    steps: [
      {
        id: 'swap', kind: 'transaction' as const, label: 'Swap', depends_on: [],
        transaction: { chain_id: chainId, from: WALLET, to, data: '0xfeed' as const, value },
        simulation: { status: 'succeeded' as const },
      },
    ],
  });
  const withDevBuy = (amountRaw: string, extra: Partial<Draft['devBuy']> = {}) => {
    const draft = draftWith();
    draft.devBuy = { ...draft.devBuy, enabled: true, amountRaw, ...extra };
    return draft;
  };

  it('waits for indexing, waits out the anti-snipe window, then swaps with native value', async () => {
    api.indexedFromCall = 3;
    api.swapPrepareImpl = async () => swapPlan('50000000000000000');
    const outcome = await run(job(withDevBuy('50000000000000000')));

    expect(outcome.devBuy).toMatchObject({ status: 'done', approvalTxs: [] });
    expect(api.indexedCalls).toBe(3);
    // indexing polls (2s each) then a 19s anti-snipe wait: launch@1000 + 20s window + 3s margin - latest@1004
    expect(clock.sleeps).toContain(19_000);
    expect(events.map((e) => e.stage)).toContain('devbuy-waiting');

    expect(api.quoteCalls[0]).toEqual({
      chain_id: 8453, wallet: WALLET, token_address: TOKEN, side: 'buy', amount_in_raw: '50000000000000000', slippage_bps: 500,
    });
    expect(api.swapPrepareCalls[0]).toEqual({ quote_id: 'quote-1', wallet: WALLET, permit2_signature: undefined });
    expect(wallet.sent).toHaveLength(2);
    expect(wallet.sent[1]?.tx).toEqual({ to: ROUTER, data: '0xfeed', value: 50_000_000_000_000_000n });
    expect(historyLines().filter((l) => l.kind === 'devbuy').map((l) => l.status)).toEqual(['sent', 'confirmed']);
  });

  it('"now" timing skips the anti-snipe wait', async () => {
    api.swapPrepareImpl = async () => swapPlan('1000');
    const outcome = await run(job(withDevBuy('1000', { timing: 'now' })));
    expect(outcome.devBuy?.status).toBe('done');
    expect(clock.sleeps.some((ms) => ms >= 19_000)).toBe(false);
    expect(events.map((e) => e.stage)).not.toContain('devbuy-waiting');
  });

  it('does not wait when anti-snipe is off for a Tax launch', async () => {
    api.swapPrepareImpl = async () => swapPlan('1000');
    const draft = withDevBuy('1000');
    draft.tax.antiSnipe = false;
    const outcome = await run(job(draft));
    expect(outcome.devBuy?.status).toBe('done');
    expect(events.map((e) => e.stage)).not.toContain('devbuy-waiting');
  });

  it('a Standard launch on Arc has no surcharge, so no wait either', async () => {
    api.configs['non-tax'] = configFor('non-tax', 5042);
    api.swapPrepareImpl = async () => swapPlan('1000', ROUTER, 5042);
    const draft = withDevBuy('1000');
    draft.product = 'non-tax';
    draft.chainId = 5042;
    (wallet as { enabledChains: () => number[] }).enabledChains = () => [5042];
    // the FakeApi plan uses body.chain_id, so this exercises chain 5042 end to end
    api.planFactory = (body) => {
      const plan = launchPlan(body, clock.ms);
      (plan.steps[0] as { transaction: { chain_id: number } }).transaction.chain_id = 5042;
      return plan;
    };
    const outcome = await run(job(draft));
    expect(outcome.devBuy?.status).toBe('done');
    expect(events.map((e) => e.stage)).not.toContain('devbuy-waiting');
  });

  it('ERC-20 pair: sends the approval, signs Permit2 and passes the signature to prepare', async () => {
    api.quoteImpl = async () => ({
      quote_id: 'quote-usdc',
      issues: [],
      steps: [
        {
          id: 'approve-permit2', kind: 'transaction', label: 'Approve', depends_on: [],
          transaction: { chain_id: 8453, from: WALLET, ...approve(USDC, addr(0x2003)), value: '0' },
          simulation: { status: 'succeeded' },
        },
        {
          id: 'permit', kind: 'typed_data', label: 'Permit2', depends_on: ['approve-permit2'],
          typed_data: {
            domain: { name: 'Permit2', chainId: 8453, verifyingContract: addr(0x2003) },
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
            message: { details: { token: USDC, amount: '5000000', expiration: 1900000000, nonce: 0 }, spender: ROUTER, sigDeadline: '1900000000' },
          },
        },
      ],
    });
    api.swapPrepareImpl = async () => swapPlan('0');
    const draft = draftWith({ quote: { address: USDC, symbol: 'USDC', decimals: 6, route: 'standard', assetType: 'stablecoin' } });
    draft.devBuy = { ...draft.devBuy, enabled: true, amountRaw: '5000000' };
    const outcome = await run(job(draft));

    expect(outcome.devBuy).toMatchObject({ status: 'done' });
    if (outcome.devBuy?.status !== 'done') throw new Error('unreachable');
    expect(outcome.devBuy.approvalTxs).toHaveLength(1);
    expect(wallet.sent.map((s) => s.tx.to)).toEqual([FACTORY, USDC, ROUTER]);
    expect(wallet.sent[2]?.tx.value).toBe(0n);
    expect(wallet.signed[0]?.message.sigDeadline).toBe(1_900_000_000n);
    expect(api.swapPrepareCalls[0]?.permit2_signature).toBe(`0x${'ab'.repeat(65)}`);
  });

  it('a failing dev buy never turns a successful launch into a failure', async () => {
    api.quoteImpl = async () => {
      throw new ApiError(422, 'simulation_failed', 'router reverted', { status: 422, code: 'simulation_failed', detail: 'router reverted' });
    };
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.token).toBe(TOKEN);
    expect(outcome.devBuy).toMatchObject({ status: 'failed' });
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.reason).toMatch(/router reverted/);
    expect(wallet.sent).toHaveLength(1); // only the launch
    expect(historyLines().at(-1)).toMatchObject({ kind: 'devbuy', status: 'failed' });
  });

  it('fails cleanly when the swap response has no recognisable transaction', async () => {
    api.swapPrepareImpl = async () => ({ something: 'else' });
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.reason).toMatch(/tidak berisi transaksi/);
  });

  it('refuses a swap that would send more native value than the dev buy amount', async () => {
    api.swapPrepareImpl = async () => swapPlan('1001');
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status).toBe('failed');
    expect(wallet.sent).toHaveLength(1);
  });

  it('refuses a swap routed to an unknown contract', async () => {
    api.swapPrepareImpl = async () => swapPlan('1000', addr(0xbad));
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.reason).toMatch(/keamanan/);
    expect(wallet.sent).toHaveLength(1);
  });

  it('gives up if the token never shows up in the API index', async () => {
    api.indexedFromCall = 10_000;
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.reason).toMatch(/belum terindeks/);
  });

  it('requotes once when the API says the quote went stale', async () => {
    let calls = 0;
    api.swapPrepareImpl = async () => {
      calls++;
      if (calls === 1) throw new ApiError(409, 'stale_quote', 'stale', { status: 409, code: 'stale_quote' });
      return swapPlan('1000');
    };
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status).toBe('done');
    expect(api.quoteCalls).toHaveLength(2);
  });

  it('does not touch stock pairs differently: uses the same flow with the stock quote', async () => {
    api.swapPrepareImpl = async () => swapPlan('0');
    api.quoteImpl = async () => ({ quote_id: 'q', issues: [], steps: [] });
    const draft = draftWith({ quote: { address: AAPL, symbol: 'AAPL', decimals: 8, route: 'rwa', assetType: 'tokenized_security' } });
    draft.devBuy = { ...draft.devBuy, enabled: true, amountRaw: '100000000' };
    const outcome = await run(job(draft));
    expect(outcome.devBuy?.status).toBe('done');
    expect(api.prepareCalls[0]?.body.market).toBe('rwa');
  });
});
