import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, erc20Abi, maxUint256, zeroAddress, type Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { newDraft, type Draft } from '../src/domain/draft.js';
import { validateImage } from '../src/domain/validators.js';
import { TxRevertedError, TxUnknownError, UserFacingError } from '../src/errors.js';
import { silentLogger } from '../src/logger.js';
import { Catalog } from '../src/o1/catalog.js';
import { ApiError } from '../src/o1/client.js';
import { History, type HistoryEntry } from '../src/services/history.js';
import {
  DraftAlreadyLaunchedError,
  Launcher,
  PendingLaunchError,
  contractsOf,
  type LaunchJob,
  type ProgressEvent,
  type ReviewedFee,
} from '../src/services/launcher.js';
import { BroadcastRejectedError } from '../src/wallet/wallet.js';
import { FEE_RAW, FakeApi, FakeClock, FakeWallet, START_MS, launchPlan, tempDir } from './fakes.js';
import { AAPL, FACTORY, PERMIT2, ROUTER, TOKEN, USDC, WALLET, ZERO, addr, configFor, suite } from './fixtures.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const NOW_S = Math.floor(START_MS / 1000);

const approve = (token: string, spender: Address, amount = 5n) => ({
  to: token as Address,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
});

const NATIVE_FEE: ReviewedFee = { currency: zeroAddress, amountRaw: BigInt(FEE_RAW) };
const USDC_FEE: ReviewedFee = { currency: USDC, amountRaw: 5n };

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

function job(draft = draftWith(), reviewedFee: ReviewedFee = NATIVE_FEE): LaunchJob {
  return { draft, reviewedFee, reviewedContracts: contractsOf(suite('tax')) };
}

const run = (j = job()) => launcher.run(j, (e) => void events.push(e));

function makeLauncher(extra: Partial<ConstructorParameters<typeof Launcher>[0]> = {}) {
  return new Launcher({
    api,
    catalog: new Catalog(api),
    wallet,
    history: new History(dir),
    log: silentLogger,
    sleep: clock.sleep,
    now: clock.now,
    ...extra,
  });
}

beforeEach(() => {
  clock = new FakeClock();
  api = new FakeApi(clock);
  wallet = new FakeWallet();
  dir = tempDir();
  events = [];
  launcher = makeLauncher();
});

const historyFile = () => join(dir, 'launches.jsonl');
const historyLines = () =>
  readFileSync(historyFile(), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** Writes history lines directly, so tests can control their timestamps. */
function seedHistory(entries: Array<Partial<HistoryEntry> & Pick<HistoryEntry, 'status' | 'txHash'>>) {
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify({ ts: new Date(START_MS - 60_000).toISOString(), kind: 'launch', chainId: 8453, ...e }));
  writeFileSync(historyFile(), lines.join('\n') + '\n');
}

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

const withDevBuy = (amountRaw: string, extra: Partial<Draft['devBuy']> = {}, draft = draftWith()) => {
  draft.devBuy = { ...draft.devBuy, enabled: true, amountRaw, ...extra };
  return draft;
};

/** Replaces the steps of the next launch plans. */
function plansWith(steps: (call: number) => unknown[]) {
  api.planFactory = (body, call) => launchPlan(body, clock.ms, { steps: steps(call) as never });
}
const txStep = (id: string, tx: { to: string; data: string; value?: string }, extra: Record<string, unknown> = {}, chainId = 8453) => ({
  id,
  kind: 'transaction' as const,
  label: id,
  depends_on: [],
  transaction: { chain_id: chainId, from: WALLET, value: '0', ...tx },
  simulation: { status: 'succeeded' },
  ...extra,
});
const createStep = (value = FEE_RAW, extra: Record<string, unknown> = {}) => txStep('create-launch', { to: FACTORY, data: '0xabcdef', value }, extra);

describe('happy path', () => {
  it('prepares, signs exactly the API transaction, confirms and verifies the token', async () => {
    const outcome = await run();

    expect(outcome).toMatchObject({ chainId: 8453, token: TOKEN, codeVerified: true });
    expect(outcome.devBuy).toBeUndefined();

    expect(api.prepareCalls).toHaveLength(1);
    const { body, key } = api.prepareCalls[0]!;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toMatchObject({ chain_id: 8453, creator: WALLET, launch_product: 'tax', market: 'standard', quote_address: ZERO });
    expect(body.token.name).toBe('Pepe Coin');

    expect(wallet.sent).toHaveLength(1);
    expect(wallet.sent[0]?.tx).toEqual({ to: FACTORY, data: '0xabcdef', value: BigInt(FEE_RAW) });
    expect(outcome.launchTx).toBe(wallet.sent[0]?.hash);

    expect(events.map((e) => e.stage)).toEqual(['checking', 'preparing', 'sending', 'confirming', 'verifying']);
  });

  it('writes the hash to the history BEFORE the transaction can reach the network', async () => {
    let seenAtBroadcast: Array<Record<string, unknown>> = [];
    wallet.onBroadcast = (tx) => {
      seenAtBroadcast = historyLines().filter((l) => l.txHash === tx.hash);
    };
    await run();

    expect(seenAtBroadcast).toHaveLength(1);
    expect(seenAtBroadcast[0]).toMatchObject({ kind: 'launch', status: 'sent', chainId: 8453, name: 'Pepe Coin', symbol: 'PEPE', token: TOKEN });
    expect(historyLines().map((l) => [l.kind, l.status])).toEqual([
      ['launch', 'sent'],
      ['launch', 'confirmed'],
    ]);
    const recent = await new History(dir).recent('launch', 5);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ status: 'confirmed', token: TOKEN });
  });

  it('never broadcasts when the hash cannot be recorded first', async () => {
    class FullDisk extends History {
      override async append(): Promise<void> {
        throw new Error('ENOSPC: no space left on device');
      }
    }
    const broken = makeLauncher({ history: new FullDisk(dir) });
    const err = await broken.run(job(), () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.message).toMatch(/TIDAK dikirim/);
    expect(wallet.signedTxs).toHaveLength(1); // signing is harmless: the transaction never left the process
    expect(wallet.broadcasts).toHaveLength(0);
    expect(wallet.sent).toHaveLength(0);
  });

  it('retries the code check when the RPC lags, and flags an unverified token', async () => {
    wallet.codeAfterCalls = 2;
    expect((await run()).codeVerified).toBe(true);
    wallet.codeAfterCalls = 99;
    const second = await launcher.run(job(), () => {});
    expect(second.codeVerified).toBe(false);
  });

  it('a failing progress callback or a hanging one never blocks the launch', async () => {
    const outcome = await launcher.run(job(), (event) => {
      if (event.stage === 'preparing') throw new Error('telegram exploded');
      if (event.stage === 'sending') return new Promise<void>(() => {}); // never settles
      return Promise.reject(new Error('rejected'));
    });
    expect(outcome.launchTx).toBeDefined();
    expect(wallet.sent).toHaveLength(1);
  });
});

describe('fee review', () => {
  it('aborts when the live fee is higher than the fee the user reviewed', async () => {
    await expect(run(job(draftWith(), { ...NATIVE_FEE, amountRaw: NATIVE_FEE.amountRaw - 1n }))).rejects.toThrow(/Fee launch naik/);
    expect(api.prepareCalls).toHaveLength(0);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('accepts a fee that went down', async () => {
    await expect(run(job(draftWith(), { ...NATIVE_FEE, amountRaw: NATIVE_FEE.amountRaw * 2n }))).resolves.toBeDefined();
  });

  it('aborts when the fee currency changed since the review', async () => {
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toThrow(/Mata uang creation fee berubah/);
    expect(api.prepareCalls).toHaveLength(0);
  });

  it('treats an ERC-20 fee like any other: a higher live amount aborts', async () => {
    const cfg = configFor('tax');
    cfg.suites![0]!.creation_fee = { amount_raw: '6', currency: USDC, symbol: 'USDC', decimals: 6 };
    api.configs.tax = cfg;
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toThrow(/Fee launch naik/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('a free launch requires a plan that carries no value at all', async () => {
    const cfg = configFor('tax');
    cfg.suites![0]!.creation_fee = { amount_raw: '0', currency: ZERO, symbol: 'ETH', decimals: 18 };
    api.configs.tax = cfg;
    const free: ReviewedFee = { currency: zeroAddress, amountRaw: 0n };
    plansWith(() => [createStep('1')]);
    await expect(run(job(draftWith(), free))).rejects.toThrow(/melebihi/);
    plansWith(() => [createStep('0')]);
    await expect(run(job(draftWith(), free))).resolves.toBeDefined();
  });
});

describe('plan validation happens for the whole plan, before anything is signed', () => {
  it('refuses a plan whose transaction targets an unknown contract', async () => {
    plansWith(() => [txStep('create-launch', { to: addr(0xbad), data: '0xabcdef', value: FEE_RAW })]);
    await expect(run()).rejects.toThrow(/ditolak demi keamanan/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('refuses a plan that asks for more value than the reviewed fee', async () => {
    plansWith(() => [createStep((BigInt(FEE_RAW) * 2n).toString())]);
    await expect(run()).rejects.toThrow(/melebihi/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('a bad LAST step stops the launcher before the good FIRST step is sent', async () => {
    api.configs.tax = withFeeCurrency(USDC, '5');
    plansWith(() => [
      txStep('approve-fee', approve(USDC, FACTORY)),
      txStep('create-launch', { to: addr(0xbad), data: '0xabcdef' }, { depends_on: ['approve-fee'] }),
    ]);
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toThrow(/ditolak demi keamanan/);
    expect(wallet.signedTxs).toHaveLength(0);
    expect(wallet.broadcasts).toHaveLength(0);
  });

  it('refuses plans with a call before the last step, no call at the end, or too many steps', async () => {
    plansWith(() => [createStep('0'), createStep()]);
    await expect(run()).rejects.toThrow(/hanya langkah terakhir/);
    api.configs.tax = withFeeCurrency(USDC, '5');
    plansWith(() => [txStep('approve-fee', approve(USDC, FACTORY))]);
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toThrow(/langkah terakhir harus berupa panggilan/);
    plansWith(() => Array.from({ length: 5 }, (_, i) => txStep(`a${i}`, approve(USDC, FACTORY, BigInt(i)))));
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toThrow(/terlalu banyak langkah/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('refuses an unlimited approval and an approval to a spender that is not the factory', async () => {
    api.configs.tax = withFeeCurrency(USDC, '5');
    plansWith(() => [txStep('approve-fee', approve(USDC, FACTORY, maxUint256)), createStep('0')]);
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toThrow(/melebihi batas/);
    plansWith(() => [txStep('approve-fee', approve(USDC, addr(0xbad), 5n)), createStep('0')]);
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toThrow(/bukan kontrak yang diizinkan/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('refuses a token that is neither the fee token nor the pair, and any non-approve call to a token', async () => {
    api.configs.tax = withFeeCurrency(USDC, '5');
    plansWith(() => [txStep('approve-x', approve(addr(0x9999), FACTORY)), createStep('0')]);
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toThrow(/ditolak demi keamanan/);
    plansWith(() => [txStep('transfer', { to: USDC, data: '0xa9059cbb' + '00'.repeat(64) }), createStep('0')]);
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toThrow(/hanya boleh menerima approve/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('a native-fee launch may not approve anything (nothing needs an allowance)', async () => {
    api.configs.tax = withFeeCurrency(USDC, '0'); // any USDC approval would be a surprise
    plansWith(() => [txStep('approve-x', approve(USDC, FACTORY, 1n)), createStep()]);
    await expect(run(job(draftWith(), NATIVE_FEE))).rejects.toThrow(/ditolak demi keamanan/);
  });

  it('refuses a step for another chain or a step that is not sent from the bot wallet', async () => {
    plansWith(() => [txStep('create-launch', { to: FACTORY, data: '0xabcdef', value: FEE_RAW }, {}, 56)]);
    await expect(run()).rejects.toThrow(/bukan chain yang dipilih/);
    plansWith(() => [{ ...createStep(), transaction: { chain_id: 8453, from: addr(0xbad), to: FACTORY, data: '0xabcdef', value: FEE_RAW } }]);
    await expect(run()).rejects.toThrow(/pengirim bukan wallet bot/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('trusts an extra contract only when the owner listed it', async () => {
    const extra = addr(0x9999);
    plansWith(() => [txStep('create-launch', { to: extra, data: '0xabcdef', value: FEE_RAW })]);
    await expect(run()).rejects.toThrow(/ditolak demi keamanan/);
    launcher = makeLauncher({ extraTargets: [extra] });
    await expect(run()).resolves.toBeDefined();
    expect(wallet.sent[0]?.tx.to).toBe(extra);
  });

  it('refuses a plan for another wallet, another chain, or with blocking issues', async () => {
    api.planFactory = (body) => launchPlan(body, clock.ms, { actor: addr(0xbad) });
    await expect(run()).rejects.toThrow(/wallet lain/);
    api.planFactory = (body) => launchPlan(body, clock.ms, { chain_id: 56 });
    await expect(run()).rejects.toThrow(/chain 56/);
    api.planFactory = (body) =>
      launchPlan(body, clock.ms, { issues: [{ code: 'insufficient_balance', severity: 'blocking', detail: 'Saldo kurang', actual_raw: '1', required_raw: '2' }] });
    await expect(run()).rejects.toThrow(/Saldo kurang/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('refuses an empty plan and an invalid predicted token address', async () => {
    api.planFactory = (body) => launchPlan(body, clock.ms, { steps: [] });
    await expect(run()).rejects.toThrow(/tidak mengembalikan transaksi/);
    api.planFactory = (body) => launchPlan(body, clock.ms, { predicted_token_address: '0x12' as Address });
    await expect(run()).rejects.toThrow(/alamat token yang valid/);
  });

  it('a gas estimate that reverts stops the launch without recording or sending anything', async () => {
    wallet.signError = new UserFacingError('Estimasi gas gagal (transaksi kemungkinan akan revert): LaunchExpired');
    await expect(run()).rejects.toThrow(/Estimasi gas gagal/);
    expect(wallet.broadcasts).toHaveLength(0);
    expect(() => readFileSync(historyFile(), 'utf8')).toThrow(); // no history file at all
  });
});

function withFeeCurrency(currency: Address, amount: string) {
  const cfg = configFor('tax');
  cfg.suites![0]!.creation_fee = { amount_raw: amount, currency, symbol: 'USDC', decimals: 6 };
  return cfg;
}

describe('transaction outcomes', () => {
  it('reports a reverted launch with its hash and skips the dev buy', async () => {
    wallet.receipts = ['reverted'];
    const err = await run(job(withDevBuy('1000'))).catch((e) => e);
    expect(err).toBeInstanceOf(TxRevertedError);
    expect(err.txHash).toBe(wallet.sent[0]?.hash);
    expect(api.indexedCalls).toBe(0);
    expect(historyLines().map((l) => l.status)).toEqual(['sent', 'reverted']);
    // a reverted launch is settled: it must not block the next one
    expect(await launcher.pendingLaunches()).toEqual([]);
  });

  it('reports an unconfirmed launch as unknown, never resends, and blocks the next launch', async () => {
    wallet.receipts = ['timeout'];
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(TxUnknownError);
    expect(err.message).toMatch(/explorer/);
    expect(wallet.broadcasts).toHaveLength(1);
    expect(historyLines().map((l) => l.status)).toEqual(['sent', 'unknown']);

    wallet.statuses.set(err.txHash, 'pending'); // still in the mempool
    const blocked = await run().catch((e) => e);
    expect(blocked).toBeInstanceOf(PendingLaunchError);
    expect(blocked.message).toContain(err.txHash);
    expect(api.prepareCalls).toHaveLength(1); // no second launch was even prepared
  });

  it('a broadcast the node refuses is recorded as failed, and does not block the next launch', async () => {
    wallet.broadcastBehaviors = ['rejected'];
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(BroadcastRejectedError);
    expect(historyLines().map((l) => l.status)).toEqual(['sent', 'failed']);
    expect(wallet.sent).toHaveLength(0);
    expect(await launcher.pendingLaunches()).toEqual([]);
    await expect(run()).resolves.toBeDefined();
  });

  it('a lost broadcast reply is settled by looking the hash up: one transaction, no resend', async () => {
    wallet.broadcastBehaviors = ['uncertain-landed'];
    const outcome = await run();
    expect(outcome.launchTx).toBe(wallet.sent[0]?.hash);
    expect(wallet.broadcasts).toHaveLength(1); // never sent twice
    expect(wallet.signedTxs).toHaveLength(1);
    expect(historyLines().map((l) => l.status)).toEqual(['sent', 'confirmed']);
  });

  it('a lost reply for a transaction the chain never saw is reported unknown and blocks further launches', async () => {
    wallet.broadcastBehaviors = ['uncertain-lost'];
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(TxUnknownError);
    expect(err.message).toMatch(/explorer/);
    expect(wallet.broadcasts).toHaveLength(1); // no blind retry
    expect(clock.sleeps.filter((ms) => ms === 3_000)).toHaveLength(4); // 5 lookups, 4 waits
    expect(historyLines().map((l) => l.status)).toEqual(['sent', 'unknown']);

    await expect(run()).rejects.toBeInstanceOf(PendingLaunchError);
    expect(wallet.signedTxs).toHaveLength(1);
  });

  it('keeps waiting instead of assuming when the RPC cannot answer the status lookup', async () => {
    wallet.broadcastBehaviors = ['uncertain-lost'];
    wallet.statusError = true;
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(TxUnknownError);
    expect(wallet.statusCalls).toBe(5);
    expect(wallet.broadcasts).toHaveLength(1);
  });

  it('prepares again when the plan is about to expire', async () => {
    api.planFactory = (body, call) =>
      call === 1 ? launchPlan(body, clock.ms, { expires_at: new Date(clock.ms + 1_000).toISOString() }) : launchPlan(body, clock.ms);
    await run();
    expect(api.prepareCalls).toHaveLength(2);
    expect(api.prepareCalls[0]?.key).not.toBe(api.prepareCalls[1]?.key);
    expect(wallet.sent).toHaveLength(1);
  });

  it('gives up if the API keeps returning stale plans, having signed nothing', async () => {
    api.planFactory = (body) => launchPlan(body, clock.ms, { expires_at: new Date(clock.ms - 1).toISOString() });
    await expect(run()).rejects.toThrow(/tidak stabil/);
    expect(api.prepareCalls).toHaveLength(3);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('fails closed on a plan without a usable expiry', async () => {
    api.planFactory = (body) => launchPlan(body, clock.ms, { expires_at: 'soon', prepared_at: 'now' });
    await expect(run()).rejects.toThrow(/waktu kedaluwarsa/);
    api.planFactory = (body) => launchPlan(body, clock.ms, { expires_at: undefined as never });
    await expect(run()).rejects.toThrow(/waktu kedaluwarsa/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('measures the plan lifetime from the API timestamps, so a skewed local clock changes nothing', async () => {
    // The API clock is an hour behind ours: by our clock this plan "expired" half an hour ago.
    const behind = clock.ms - 3_600_000;
    api.planFactory = (body) => launchPlan(body, behind);
    await expect(run()).resolves.toBeDefined();
    expect(api.prepareCalls).toHaveLength(1);

    // ... and a plan with a 2 second lifetime is stale on any clock.
    let calls = 0;
    api.planFactory = (body) =>
      ++calls === 1 ? launchPlan(body, behind, { expires_at: new Date(behind + 2_000).toISOString() }) : launchPlan(body, behind);
    launcher = makeLauncher();
    await expect(run()).resolves.toBeDefined();
    expect(api.prepareCalls).toHaveLength(3);
  });

  it('prepares again when signing an approval used up the plan lifetime', async () => {
    api.configs.tax = withFeeCurrency(USDC, '5');
    const shortLived = (body: Parameters<typeof launchPlan>[0], call: number) => {
      const lifetime = call === 1 ? 10_000 : 30 * 60_000;
      return launchPlan(body, clock.ms, {
        expires_at: new Date(clock.ms + lifetime).toISOString(),
        steps: [txStep('approve-fee', approve(USDC, FACTORY)), createStep('0', { depends_on: ['approve-fee'] })] as never,
      });
    };
    api.planFactory = shortLived;
    // the approval takes a long time to confirm: the first plan is stale by the time it is done
    const original = wallet.waitForReceipt.bind(wallet);
    wallet.waitForReceipt = async (...args) => {
      clock.ms += 30_000;
      return original(...args);
    };
    const outcome = await run(job(draftWith(), USDC_FEE));
    expect(api.prepareCalls).toHaveLength(2);
    expect(wallet.sent.map((s) => s.tx.to)).toEqual([USDC, FACTORY]); // the approval was NOT sent a second time
    expect(outcome.launchTx).toBe(wallet.sent[1]?.hash);
  });

  it('sends an ERC-20 fee approval first when the launch step is not_run, then prepares again', async () => {
    api.configs.tax = withFeeCurrency(USDC, '5');
    plansWith((call) =>
      call > 1
        ? [createStep('0')]
        : [txStep('approve-fee', approve(USDC, FACTORY)), createStep('0', { depends_on: ['approve-fee'], simulation: { status: 'not_run' } })],
    );
    const outcome = await run(job(draftWith(), USDC_FEE));
    expect(api.prepareCalls).toHaveLength(2);
    expect(wallet.sent.map((s) => s.tx.to)).toEqual([USDC, FACTORY]);
    expect(outcome.launchTx).toBe(wallet.sent[1]?.hash);
    expect(historyLines().map((l) => [l.kind, l.status])).toEqual([
      ['approval', 'sent'],
      ['approval', 'confirmed'],
      ['launch', 'sent'],
      ['launch', 'confirmed'],
    ]);
  });

  it('does not treat a not_run launch without prerequisites as something to loop on', async () => {
    plansWith(() => [createStep(FEE_RAW, { simulation: { status: 'not_run' } })]);
    await expect(run()).rejects.toThrow(/belum disimulasikan tanpa prasyarat/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('an approval that reverts stops the launch before the launch step', async () => {
    api.configs.tax = withFeeCurrency(USDC, '5');
    plansWith(() => [txStep('approve-fee', approve(USDC, FACTORY)), createStep('0', { depends_on: ['approve-fee'] })]);
    wallet.receipts = ['reverted'];
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toBeInstanceOf(TxRevertedError);
    expect(wallet.sent.map((s) => s.tx.to)).toEqual([USDC]);
  });
});

describe('launches whose outcome is unknown block the next one', () => {
  it('settles earlier launches that confirmed or reverted, and lets the new one proceed', async () => {
    seedHistory([
      { status: 'sent', txHash: hash(0xa1) },
      { status: 'unknown', txHash: hash(0xa2) },
    ]);
    wallet.statuses.set(hash(0xa1), 'success');
    wallet.statuses.set(hash(0xa2), 'reverted');
    await expect(run()).resolves.toBeDefined();
    const settled = (await new History(dir).recent('launch', 10)).map((e) => [e.txHash, e.status]);
    expect(settled).toContainEqual([hash(0xa1), 'confirmed']);
    expect(settled).toContainEqual([hash(0xa2), 'reverted']);
  });

  it('blocks while a previous launch is still pending or not yet visible', async () => {
    seedHistory([{ status: 'sent', txHash: hash(0xa1) }]);
    wallet.statuses.set(hash(0xa1), 'pending');
    await expect(run()).rejects.toBeInstanceOf(PendingLaunchError);

    wallet.statuses.set(hash(0xa1), 'unknown'); // recent: the node may just not have gossiped it yet
    clock.ms = START_MS;
    await expect(run()).rejects.toBeInstanceOf(PendingLaunchError);
    expect(api.prepareCalls).toHaveLength(0);
  });

  it('blocks when the RPC cannot say (never guess in favour of launching)', async () => {
    seedHistory([{ status: 'unknown', txHash: hash(0xa1) }]);
    wallet.statusError = true;
    await expect(run()).rejects.toBeInstanceOf(PendingLaunchError);
  });

  it('treats a transaction the chain has never heard of for 30 minutes as dropped', async () => {
    seedHistory([{ status: 'unknown', txHash: hash(0xa1) }]);
    wallet.statuses.set(hash(0xa1), 'unknown');
    clock.ms = START_MS + 31 * 60_000;
    await expect(run()).resolves.toBeDefined();
    expect((await new History(dir).recent('launch', 10)).find((e) => e.txHash === hash(0xa1))).toMatchObject({ status: 'failed' });
  });

  it('is released by an explicit dismissal', async () => {
    seedHistory([{ status: 'unknown', txHash: hash(0xa1) }]);
    wallet.statuses.set(hash(0xa1), 'unknown');
    await expect(run()).rejects.toBeInstanceOf(PendingLaunchError);
    expect(await launcher.dismissPending()).toBe(1);
    expect(await launcher.pendingLaunches()).toEqual([]);
    await expect(run()).resolves.toBeDefined();
  });

  it('only launches count: a pending approval or dev buy does not block', async () => {
    seedHistory([
      { kind: 'approval', status: 'sent', txHash: hash(0xb1) },
      { kind: 'devbuy', status: 'unknown', txHash: hash(0xb2) },
    ]);
    await expect(run()).resolves.toBeDefined();
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

  describe('drain (shutdown)', () => {
    const holdPrepare = () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const original = api.prepareLaunch.bind(api);
      api.prepareLaunch = async (body, key) => {
        await gate;
        return original(body, key);
      };
      return release;
    };

    it('is immediately done when idle, and closes the door', async () => {
      await expect(launcher.drain(1_000)).resolves.toBe(true);
      await expect(run()).rejects.toThrow(/dimatikan/);
      expect(api.prepareCalls).toHaveLength(0);
    });

    it('lets the running launch finish, refuses new ones meanwhile, and then reports idle', async () => {
      const release = holdPrepare();
      const first = run();
      await Promise.resolve();
      const drained = launcher.drain(5_000);
      let done = false;
      void drained.then(() => (done = true));

      await expect(run()).rejects.toThrow(/dimatikan/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(done).toBe(false); // still waiting for the launch that is in flight

      release();
      await expect(first).resolves.toMatchObject({ token: TOKEN });
      await expect(drained).resolves.toBe(true);
      expect(wallet.sent).toHaveLength(1);
    });

    it('gives up after its timeout while a launch is still running', async () => {
      const release = holdPrepare();
      const first = run();
      await Promise.resolve();
      await expect(launcher.drain(30)).resolves.toBe(false);
      expect(launcher.isBusy()).toBe(true);
      release();
      await first;
    });
  });
});

describe('dev buy (follow-up swap through the public API)', () => {
  const swapStep = (value: string, to: string = ROUTER, chainId = 8453) => txStep('swap', { to, data: '0xfeed', value }, {}, chainId);
  const swapPlan = (value: string, to: string = ROUTER, chainId = 8453) => ({ steps: [swapStep(value, to, chainId)] as never });
  const usdcDraft = (amount = '5000000') =>
    withDevBuy(amount, {}, draftWith({ quote: { address: USDC, symbol: 'USDC', decimals: 6, route: 'standard', assetType: 'stablecoin' } }));
  const permit = (overrides: Record<string, unknown> = {}, details: Record<string, unknown> = {}) => ({
    id: 'permit',
    kind: 'typed_data' as const,
    label: 'Permit2',
    depends_on: [],
    typed_data: {
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
        details: { token: USDC, amount: '5000000', expiration: NOW_S + 30 * 86_400, nonce: 0, ...details },
        spender: ROUTER,
        sigDeadline: String(NOW_S + 3_600),
        ...overrides,
      },
    },
  });
  const usdcQuote = (permitStep = permit()) => async () => ({
    quote_id: 'quote-usdc',
    issues: [],
    steps: [txStep('approve-permit2', approve(USDC, PERMIT2, maxUint256)), permitStep] as never,
  });

  it('waits for indexing, waits out the anti-snipe window, then swaps with native value', async () => {
    api.indexedFromCall = 3;
    api.swapPrepareImpl = async () => swapPlan('50000000000000000');
    const outcome = await run(job(withDevBuy('50000000000000000')));

    expect(outcome.devBuy).toMatchObject({ status: 'done', approvalTxs: [] });
    expect(api.indexedCalls).toBe(3);
    // launch@1000 + 20s window + 3s margin - latest@1004
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

  it('never waits longer than a bounded window, whatever the API or a lagging RPC clock claim', async () => {
    const cfg = configFor('tax');
    (cfg.suites![0]!.tax_policy as { anti_snipe_configuration: { window_seconds: number } }).anti_snipe_configuration.window_seconds = 100_000;
    api.configs.tax = cfg;
    api.swapPrepareImpl = async () => swapPlan('1000');
    wallet.latestTimestamp = 0; // the RPC's latest block is far behind the launch block
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status).toBe('done');
    const waits = clock.sleeps.filter((ms) => ms > 10_000);
    expect(Math.max(...waits)).toBeLessThanOrEqual(183_000);
  });

  it('a Standard launch on Arc has no surcharge, so no wait either', async () => {
    api.configs['non-tax'] = configFor('non-tax', 5042);
    api.swapPrepareImpl = async () => swapPlan('1000', ROUTER, 5042);
    const draft = withDevBuy('1000');
    draft.product = 'non-tax';
    draft.chainId = 5042;
    wallet.chains = [5042];
    plansWith(() => [txStep('create-launch', { to: FACTORY, data: '0xabcdef', value: FEE_RAW }, {}, 5042)]);
    const outcome = await run(job(draft));
    expect(outcome.devBuy?.status).toBe('done');
    expect(events.map((e) => e.stage)).not.toContain('devbuy-waiting');
  });

  it('ERC-20 pair: approves Permit2, signs a bounded permit and passes the signature to prepare', async () => {
    api.quoteImpl = usdcQuote();
    api.swapPrepareImpl = async () => swapPlan('0');
    const outcome = await run(job(usdcDraft()));

    if (outcome.devBuy?.status !== 'done') throw new Error(`dev buy: ${JSON.stringify(outcome.devBuy)}`);
    expect(outcome.devBuy.approvalTxs).toHaveLength(1);
    expect(wallet.sent.map((s) => s.tx.to)).toEqual([FACTORY, USDC, ROUTER]);
    expect(wallet.sent[2]?.tx.value).toBe(0n);
    expect(wallet.signed[0]?.message.sigDeadline).toBe(BigInt(NOW_S + 3_600));
    expect(api.swapPrepareCalls[0]?.permit2_signature).toBe(`0x${'ab'.repeat(65)}`);
  });

  it('does not send the same approval twice when the swap plan repeats a quote prerequisite', async () => {
    api.quoteImpl = usdcQuote();
    api.swapPrepareImpl = async () => ({ steps: [txStep('approve-permit2', approve(USDC, PERMIT2, maxUint256)), swapStep('0')] as never });
    const outcome = await run(job(usdcDraft()));
    expect(outcome.devBuy?.status).toBe('done');
    expect(wallet.sent.map((s) => s.tx.to)).toEqual([FACTORY, USDC, ROUTER]);
  });

  describe('a hostile quote or swap plan cannot get more than the dev buy the owner reviewed', () => {
    const failed = (outcome: Awaited<ReturnType<typeof run>>) => (outcome.devBuy?.status === 'failed' ? outcome.devBuy.reason : `not failed: ${JSON.stringify(outcome.devBuy)}`);

    it('refuses more native value than the dev buy amount', async () => {
      api.swapPrepareImpl = async () => swapPlan('1001');
      const outcome = await run(job(withDevBuy('1000')));
      expect(failed(outcome)).toMatch(/melebihi/);
      expect(wallet.sent).toHaveLength(1); // only the launch
    });

    it('refuses a swap routed to an unknown contract', async () => {
      api.swapPrepareImpl = async () => swapPlan('1000', addr(0xbad));
      expect(failed(await run(job(withDevBuy('1000'))))).toMatch(/keamanan/);
      expect(wallet.sent).toHaveLength(1);
    });

    it('never lets the swap go to the launch factory or to Permit2', async () => {
      api.swapPrepareImpl = async () => swapPlan('1000', FACTORY);
      expect(failed(await run(job(withDevBuy('1000'))))).toMatch(/keamanan/);
      api.swapPrepareImpl = async () => swapPlan('1000', PERMIT2);
      launcher = makeLauncher();
      expect(failed(await run(job(withDevBuy('1000'))))).toMatch(/keamanan/);
    });

    it('treats the steps of a quote as prerequisites only: a swap hidden in a quote is refused', async () => {
      api.quoteImpl = async () => ({ quote_id: 'q', issues: [], steps: [swapStep('1000')] as never });
      api.swapPrepareImpl = async () => swapPlan('1000');
      expect(failed(await run(job(withDevBuy('1000'))))).toMatch(/hanya approve/);
      expect(wallet.sent).toHaveLength(1);
    });

    it('refuses a quote prerequisite that approves more than the dev buy amount to a router', async () => {
      api.quoteImpl = async () => ({ quote_id: 'q', issues: [], steps: [txStep('approve', approve(USDC, ROUTER, 6_000_000n))] as never });
      api.swapPrepareImpl = async () => swapPlan('0');
      expect(failed(await run(job(usdcDraft())))).toMatch(/melebihi batas/);
      expect(wallet.sent).toHaveLength(1);
    });

    it('refuses to approve anything to an address that is not a router or Permit2', async () => {
      api.quoteImpl = async () => ({ quote_id: 'q', issues: [], steps: [txStep('approve', approve(USDC, addr(0xbad), 1n))] as never });
      api.swapPrepareImpl = async () => swapPlan('0');
      expect(failed(await run(job(usdcDraft())))).toMatch(/bukan kontrak yang diizinkan/);
    });

    it('refuses a permit for more than the dev buy amount', async () => {
      api.quoteImpl = usdcQuote(permit({}, { amount: '5000001' }));
      expect(failed(await run(job(usdcDraft())))).toMatch(/jumlah permit/);
      expect(api.swapPrepareCalls).toHaveLength(0);
      expect(wallet.signed).toHaveLength(0);
    });

    it('refuses a permit whose allowance or signature lives too long', async () => {
      api.quoteImpl = usdcQuote(permit({}, { expiration: NOW_S + 400 * 86_400 }));
      expect(failed(await run(job(usdcDraft())))).toMatch(/masa berlaku/);
      launcher = makeLauncher();
      api.quoteImpl = usdcQuote(permit({ sigDeadline: String(NOW_S + 7 * 86_400) }));
      expect(failed(await run(job(usdcDraft())))).toMatch(/batas waktu tanda tangan/);
      expect(wallet.signed).toHaveLength(0);
    });

    it('refuses a permit for another token, another spender or another Permit2 contract', async () => {
      api.quoteImpl = usdcQuote(permit({}, { token: addr(0x9999) }));
      expect(failed(await run(job(usdcDraft())))).toMatch(/bukan pair yang dipilih/);
      launcher = makeLauncher();
      api.quoteImpl = usdcQuote(permit({ spender: addr(0xbad) }));
      expect(failed(await run(job(usdcDraft())))).toMatch(/spender bukan router/);
      launcher = makeLauncher();
      const other = permit();
      other.typed_data.domain.verifyingContract = addr(0xbad);
      api.quoteImpl = usdcQuote(other);
      expect(failed(await run(job(usdcDraft())))).toMatch(/bukan yang dipercaya/);
      expect(wallet.signed).toHaveLength(0);
    });
  });

  it('a failing dev buy never turns a successful launch into a failure', async () => {
    api.quoteImpl = async () => {
      throw new ApiError(422, 'simulation_failed', 'router reverted', { status: 422, code: 'simulation_failed', detail: 'router reverted' });
    };
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.token).toBe(TOKEN);
    expect(outcome.devBuy).toMatchObject({ status: 'failed' });
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.reason).toMatch(/router reverted/);
    expect(wallet.sent).toHaveLength(1);
    expect(historyLines().at(-1)).toMatchObject({ kind: 'devbuy', status: 'failed' });
  });

  it('a reverted dev buy reports its hash', async () => {
    api.swapPrepareImpl = async () => swapPlan('1000');
    wallet.receipts = ['success', 'reverted'];
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy).toMatchObject({ status: 'failed', txHash: wallet.sent[1]?.hash });
  });

  it('an unknown dev buy broadcast is reported with its hash and never resent', async () => {
    api.swapPrepareImpl = async () => swapPlan('1000');
    wallet.broadcastBehaviors = ['ok', 'uncertain-lost'];
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status).toBe('failed');
    expect(wallet.broadcasts).toHaveLength(2);
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.txHash).toBe(wallet.signedTxs[1]?.hash);
  });

  it('fails cleanly when the swap response has no recognisable transaction', async () => {
    api.swapPrepareImpl = async () => ({ something: 'else' });
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.reason).toMatch(/tidak berisi transaksi/);
  });

  it('gives up if the token never shows up in the API index', async () => {
    api.indexedFromCall = 10_000;
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.reason).toMatch(/belum terindeks/);
  });

  it('rides out rate limits while waiting for the index, but surfaces an invalid API key at once', async () => {
    api.indexedFaults = [new ApiError(429, 'rate_limit_exceeded', 'slow down'), new ApiError(503, 'http_503', 'unavailable')];
    api.swapPrepareImpl = async () => swapPlan('1000');
    expect((await run(job(withDevBuy('1000')))).devBuy?.status).toBe('done');

    launcher = makeLauncher();
    api.indexedFaults = [new ApiError(401, 'invalid_api_key', 'bad key')];
    const started = clock.ms;
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.reason).toMatch(/API key/);
    expect(clock.ms - started).toBeLessThan(60_000); // no two minute poll on an auth error
  });

  it('requotes when the API says the quote went stale, and gives up after a few rounds', async () => {
    let calls = 0;
    api.swapPrepareImpl = async () => {
      calls++;
      if (calls === 1) throw new ApiError(409, 'stale_quote', 'stale', { status: 409, code: 'stale_quote' });
      return swapPlan('1000');
    };
    expect((await run(job(withDevBuy('1000')))).devBuy?.status).toBe('done');
    expect(api.quoteCalls).toHaveLength(2);

    launcher = makeLauncher();
    api.quoteCalls = [];
    api.swapPrepareImpl = async () => {
      throw new ApiError(409, 'stale_quote', 'stale', { status: 409, code: 'stale_quote' });
    };
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.reason).toMatch(/tidak stabil/);
    expect(api.quoteCalls).toHaveLength(3);
  });

  it('quotes again instead of sending a swap plan that is about to expire', async () => {
    let calls = 0;
    api.swapPrepareImpl = async () => {
      calls++;
      return { ...swapPlan('1000'), expires_at: new Date(clock.ms + (calls === 1 ? 2_000 : 120_000)).toISOString() };
    };
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy?.status).toBe('done');
    expect(api.quoteCalls).toHaveLength(2);
    expect(wallet.sent.filter((s) => s.tx.to === ROUTER)).toHaveLength(1);
  });

  it('stock pairs use the same flow with the stock quote', async () => {
    api.swapPrepareImpl = async () => swapPlan('0');
    const draft = withDevBuy('100000000', {}, draftWith({ quote: { address: AAPL, symbol: 'AAPL', decimals: 8, route: 'rwa', assetType: 'tokenized_security' } }));
    const outcome = await run(job(draft));
    expect(outcome.devBuy?.status).toBe('done');
    expect(api.prepareCalls[0]?.body.market).toBe('rwa');
  });
});

describe('a draft is launched at most once (round-2 review, CRITICAL)', () => {
  it('records the draft id on every launch line', async () => {
    const draft = draftWith();
    await run(job(draft));
    expect(historyLines().every((l) => l.draftId === draft.id)).toBe(true);
    expect(await launcher.priorLaunch(draft.id)).toMatchObject({ status: 'confirmed' });
    expect(await launcher.priorLaunch(draftWith().id)).toBeUndefined();
  });

  it('refuses the draft whose launch confirmed AFTER the bot had reported "unclear" (the relaunch trap)', async () => {
    wallet.receipts = ['timeout'];
    const draft = draftWith();
    const err = await run(job(draft)).catch((e) => e);
    expect(err).toBeInstanceOf(TxUnknownError);

    // still pending: everything is blocked by the pending lock
    wallet.statuses.set(err.txHash, 'pending');
    await expect(run(job(draft))).rejects.toBeInstanceOf(PendingLaunchError);

    // the transaction mines later; the lock settles silently ...
    wallet.statuses.set(err.txHash, 'success');
    const again = await run(job(draft)).catch((e) => e);
    // ... but the very same draft must not be launched a second time
    expect(again).toBeInstanceOf(DraftAlreadyLaunchedError);
    expect(again.message).toContain(err.txHash);
    expect(again.message).toContain('token kembar');
    expect(api.prepareCalls).toHaveLength(1);
    expect(wallet.broadcasts).toHaveLength(1);

    // a new draft (even with identical fields) is the owner's explicit choice
    await expect(run(job(draftWith()))).resolves.toMatchObject({ token: TOKEN });
    expect(wallet.broadcasts).toHaveLength(2);
  });

  it('a launch that failed, reverted or was dismissed can be retried with the same draft', async () => {
    const draft = draftWith();
    wallet.broadcastBehaviors = ['rejected'];
    await run(job(draft)).catch(() => {});
    wallet.receipts = ['reverted'];
    await expect(run(job(draft))).rejects.toBeInstanceOf(TxRevertedError);

    wallet.receipts = ['timeout'];
    const unknown = await run(job(draft)).catch((e) => e);
    wallet.statuses.set(unknown.txHash, 'unknown');
    await expect(run(job(draft))).rejects.toBeInstanceOf(PendingLaunchError);
    await launcher.dismissPending();
    await expect(run(job(draft))).resolves.toMatchObject({ token: TOKEN }); // finally sent, once
  });
});

describe('the contracts that receive the money are pinned at review (round-2 review)', () => {
  const withSuite = (edit: (s: ReturnType<typeof suite>) => void) => {
    const cfg = configFor('tax');
    edit(cfg.suites![0]!);
    api.configs.tax = cfg;
  };

  it('aborts, before anything is prepared, when the factory changed after the review', async () => {
    withSuite((s) => (s.contracts.factory = addr(0x9999)));
    await expect(run()).rejects.toThrow(/Alamat kontrak o1 berubah sejak Review/);
    expect(api.prepareCalls).toHaveLength(0);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('notices a changed router, universal router or Permit2 as well', async () => {
    for (const change of [{ swapx_router: addr(0x9998) }, { universal_router: addr(0x9997) }, { permit2: addr(0x9996) }]) {
      withSuite((s) => Object.assign(s.contracts, change));
      await expect(run(), JSON.stringify(change)).rejects.toThrow(/Alamat kontrak o1 berubah/);
    }
    expect(api.prepareCalls).toHaveLength(0);
  });
});

describe('a hostile /config cannot turn the dev buy into an allowance drain (round-2 review, CRITICAL)', () => {
  const ATTACKER = addr(0xbad);

  it('an unlimited USDC approval to the addresses /config calls "router" and "Permit2" is refused; nothing but the launch is sent', async () => {
    const cfg = configFor('tax');
    Object.assign(cfg.suites![0]!.contracts, { permit2: ATTACKER, swapx_router: ATTACKER });
    api.configs.tax = cfg;
    const draft = withDevBuy('5000000', {}, draftWith({ quote: { address: USDC, symbol: 'USDC', decimals: 6, route: 'standard', assetType: 'stablecoin' } }));
    // the owner "reviewed" the hostile addresses: the pin cannot help, the guard has to
    const hostileJob: LaunchJob = { draft, reviewedFee: NATIVE_FEE, reviewedContracts: contractsOf(cfg.suites![0]!) };
    api.quoteImpl = async () => ({
      quote_id: 'q',
      issues: [],
      steps: [txStep('approve', approve(USDC, ATTACKER, maxUint256))] as never,
    });
    api.swapPrepareImpl = async () => ({ steps: [txStep('swap', { to: ATTACKER, data: '0xdead', value: '0' })] as never });

    const outcome = await run(hostileJob);
    expect(outcome.devBuy).toMatchObject({ status: 'failed' });
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.reason).toMatch(/melebihi batas/);
    expect(wallet.sent.map((s) => s.tx.to)).toEqual([FACTORY]);
  });

  it('a Permit2 permit naming an attacker-claimed Permit2 contract is not signed', async () => {
    const cfg = configFor('tax');
    Object.assign(cfg.suites![0]!.contracts, { permit2: ATTACKER });
    api.configs.tax = cfg;
    const draft = withDevBuy('5000000', {}, draftWith({ quote: { address: USDC, symbol: 'USDC', decimals: 6, route: 'standard', assetType: 'stablecoin' } }));
    api.quoteImpl = async () => ({
      quote_id: 'q',
      issues: [],
      steps: [
        {
          id: 'permit', kind: 'typed_data', label: 'Permit2', depends_on: [],
          typed_data: {
            domain: { name: 'Permit2', chainId: 8453, verifyingContract: ATTACKER },
            types: {
              PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
              PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
            },
            primaryType: 'PermitSingle',
            message: { details: { token: USDC, amount: '5000000', expiration: NOW_S + 86_400, nonce: 0 }, spender: ROUTER, sigDeadline: String(NOW_S + 3_600) },
          },
        },
      ] as never,
    });
    const outcome = await run({ draft, reviewedFee: NATIVE_FEE, reviewedContracts: contractsOf(cfg.suites![0]!) });
    expect(outcome.devBuy?.status === 'failed' && outcome.devBuy.reason).toMatch(/bukan yang dipercaya/);
    expect(wallet.signed).toHaveLength(0);
  });
});

describe('a receipt for a different transaction is not a confirmation (round-2 review)', () => {
  it('a same-nonce replacement is reported as unclear, recorded, and keeps the lock', async () => {
    wallet.receipts = ['replaced'];
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(TxUnknownError);
    expect(err.message).toContain('digantikan');
    expect(err.message).toContain(`0x${'ee'.repeat(32)}`);
    expect(err.txHash).toBe(wallet.signedTxs[0]?.hash);
    expect(historyLines().map((l) => l.status)).toEqual(['sent', 'unknown']);
    expect(historyLines().at(-1).note).toContain('replaced by');

    wallet.statuses.set(err.txHash, 'unknown'); // the bot's own transaction never made it
    await expect(run()).rejects.toBeInstanceOf(PendingLaunchError);
  });
});

describe('the wallet must be idle (round-2 review)', () => {
  it('refuses a launch while transactions of the wallet are still waiting for a block', async () => {
    wallet.pendingCount = 2;
    await expect(run()).rejects.toThrow(/2 transaksi yang belum terkonfirmasi/);
    expect(api.prepareCalls).toHaveLength(0);
    expect(wallet.signedTxs).toHaveLength(0);
    wallet.pendingCount = 0;
    await expect(run()).resolves.toBeDefined();
  });

  it('does not guess when the RPC cannot say', async () => {
    wallet.pendingCountError = true;
    await expect(run()).rejects.toThrow();
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('gives up on a transaction nobody has heard of for 30 minutes only when nothing of the wallet is in the mempool', async () => {
    seedHistory([{ status: 'unknown', txHash: hash(0xa1) }]);
    wallet.statuses.set(hash(0xa1), 'unknown');
    clock.ms = START_MS + 31 * 60_000;

    wallet.pendingCount = 1; // a node counts a transaction of ours that it will not show by hash
    await expect(run()).rejects.toBeInstanceOf(PendingLaunchError);
    expect((await launcher.pendingLaunches()).map((e) => e.txHash)).toEqual([hash(0xa1)]);

    wallet.pendingCount = 0;
    await expect(run()).resolves.toBeDefined();
    expect((await new History(dir).recent('launch', 10)).find((e) => e.txHash === hash(0xa1))).toMatchObject({ status: 'failed' });
  });
});

describe('settled launches are reported', () => {
  it('calls onSettled once per pending launch that turned out confirmed, reverted or gone', async () => {
    const seen: Array<[string | undefined, string]> = [];
    launcher = makeLauncher({ onSettled: (entry, status) => void seen.push([entry.txHash, status]) });
    seedHistory([
      { status: 'unknown', txHash: hash(0xa1), name: 'One' },
      { status: 'sent', txHash: hash(0xa2), name: 'Two' },
      { status: 'unknown', txHash: hash(0xa3), name: 'Three' },
    ]);
    wallet.statuses.set(hash(0xa1), 'success');
    wallet.statuses.set(hash(0xa2), 'reverted');
    wallet.statuses.set(hash(0xa3), 'pending');
    expect((await launcher.pendingLaunches()).map((e) => e.txHash)).toEqual([hash(0xa3)]);
    expect(seen).toEqual([[hash(0xa1), 'confirmed'], [hash(0xa2), 'reverted']]);
    await launcher.pendingLaunches();
    expect(seen).toHaveLength(2); // already settled: not reported again
  });

  it('two checks at the same moment (the minute-by-minute watcher and a review) settle and announce a launch once', async () => {
    const seen: string[] = [];
    launcher = makeLauncher({ onSettled: (entry) => void seen.push(entry.txHash as string) });
    seedHistory([{ status: 'unknown', txHash: hash(0xa1) }]);
    wallet.statuses.set(hash(0xa1), 'success');
    const slow = wallet.transactionStatus.bind(wallet);
    wallet.transactionStatus = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 20)); // both callers are in flight together
      return slow(...args);
    };
    await Promise.all([launcher.pendingLaunches(), launcher.pendingLaunches(), launcher.dismissPending()]);
    expect(seen).toEqual([hash(0xa1)]);
    expect(historyLines().filter((l) => l.txHash === hash(0xa1) && l.status === 'confirmed')).toHaveLength(1);
  });

  it('a failing callback does not break the settlement', async () => {
    launcher = makeLauncher({ onSettled: () => { throw new Error('telegram down'); } });
    seedHistory([{ status: 'unknown', txHash: hash(0xa1) }]);
    wallet.statuses.set(hash(0xa1), 'success');
    await expect(launcher.pendingLaunches()).resolves.toEqual([]);
  });
});

describe('the history fails closed (round-2 review)', () => {
  it('a history that cannot be read blocks every launch instead of looking empty', async () => {
    mkdirSync(historyFile(), { recursive: true }); // a directory where the log should be: EISDIR, not ENOENT
    await expect(run()).rejects.toThrow(/Riwayat launch tidak bisa dibaca/);
    await expect(launcher.pendingLaunches()).rejects.toThrow(/diblokir demi keamanan/);
    await expect(launcher.dismissPending()).rejects.toThrow(/Riwayat launch tidak bisa dibaca/);
    expect(api.prepareCalls).toHaveLength(0);
    expect(wallet.signedTxs).toHaveLength(0);
  });
});

describe('nothing after a confirmed launch may turn it into an error (round-2 review)', () => {
  it('API error text that is not what it claims to be does not break the report', async () => {
    api.quoteImpl = async () => {
      throw new ApiError(422, 'insufficient_balance', 'no funds', {
        status: 422, code: 'insufficient_balance', asset: 5 as never, actual_raw: 'many', required_raw: { deep: true } as never,
      });
    };
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome).toMatchObject({ token: TOKEN });
    expect(outcome.devBuy?.status).toBe('failed');
  });

  it('a dev buy that blows up before its own error handling still returns the launch', async () => {
    const draft = withDevBuy('not-a-number');
    const outcome = await run(job(draft));
    expect(outcome.token).toBe(TOKEN);
    expect(outcome.devBuy?.status).toBe('failed');
    expect(wallet.sent).toHaveLength(1);
  });

  it('a code check that keeps failing leaves the launch successful, only unverified', async () => {
    wallet.hasCode = async () => {
      throw new Error('rpc down');
    };
    const outcome = await run();
    expect(outcome.codeVerified).toBe(false);
    expect(outcome.launchTx).toBe(wallet.sent[0]?.hash);
  });
});

describe('gaps the mutation run of the round-2 review exposed', () => {
  it('an approval of the fee token above the reviewed fee is refused by a single unit', async () => {
    api.configs.tax = withFeeCurrency(USDC, '5');
    plansWith(() => [txStep('approve-fee', approve(USDC, FACTORY, 6n)), createStep('0', { depends_on: ['approve-fee'] })]);
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toThrow(/melebihi batas 5/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('a prerequisite that the API did not simulate is not sent', async () => {
    api.configs.tax = withFeeCurrency(USDC, '5');
    plansWith(() => [
      txStep('approve-fee', approve(USDC, FACTORY), { simulation: { status: 'not_run' } }),
      createStep('0', { depends_on: ['approve-fee'], simulation: { status: 'not_run' } }),
    ]);
    await expect(run(job(draftWith(), USDC_FEE))).rejects.toThrow(/prasyarat ditandai belum disimulasikan/);
    expect(wallet.signedTxs).toHaveLength(0);
  });

  it('what the running launch sends comes from the snapshot, not from the live draft', async () => {
    const draft = draftWith();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = api.prepareLaunch.bind(api);
    api.prepareLaunch = async (body, key) => {
      await gate;
      return original(body, key);
    };
    const snapshot = structuredClone(draft);
    const running = run(job(snapshot));
    draft.name = 'Edited While Running'; // the live draft changes; the job has its own copy
    release();
    await running;
    expect(api.prepareCalls[0]?.body.token.name).toBe('Pepe Coin');
  });

  it('the dev buy is reported as unclear (not "buy by hand") when its swap may still land', async () => {
    api.swapPrepareImpl = async () => ({ steps: [txStep('swap', { to: ROUTER, data: '0xfeed', value: '1000' })] as never });
    wallet.broadcastBehaviors = ['ok', 'uncertain-lost'];
    const outcome = await run(job(withDevBuy('1000')));
    expect(outcome.devBuy).toMatchObject({ status: 'failed', unknown: true, txHash: wallet.signedTxs[1]?.hash });

    launcher = makeLauncher();
    wallet.receipts = ['success', 'reverted'];
    const reverted = await run(job(withDevBuy('1000')));
    expect(reverted.devBuy).toMatchObject({ status: 'failed', unknown: false });
  });
});
