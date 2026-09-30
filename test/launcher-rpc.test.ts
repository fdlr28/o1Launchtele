import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDraft, type Draft } from '../src/domain/draft.js';
import { validateImage } from '../src/domain/validators.js';
import { TxRevertedError, TxUnknownError, UserFacingError } from '../src/errors.js';
import { silentLogger } from '../src/logger.js';
import { Catalog } from '../src/o1/catalog.js';
import { DraftAlreadyLaunchedError, Launcher, PendingLaunchError, contractsOf, type LaunchJob } from '../src/services/launcher.js';
import { History } from '../src/services/history.js';
import { BroadcastRejectedError, ViemWallet } from '../src/wallet/wallet.js';
import { FEE_RAW, FakeApi, FakeClock, tempDir } from './fakes.js';
import { TOKEN, ZERO, suite } from './fixtures.js';
import { MockRpc } from './mock-rpc.js';

/**
 * The real launcher and the real signer (viem) against a mock JSON-RPC node. These replay the failure modes the
 * round-2 security review reproduced: a node that answers an error for a transaction it did take, and a
 * transaction replaced by another one with the same nonce.
 */

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Hardhat test key #0, never funded
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let rpc: MockRpc;
let wallet: ViemWallet;
let clock: FakeClock;
let api: FakeApi;
let dir: string;
let launcher: Launcher;

const draft = (): Draft => ({
  ...newDraft({ chainId: 8453, wallet: wallet.address }),
  quote: { address: ZERO, symbol: 'ETH', decimals: 18, route: 'standard', assetType: 'native' },
  name: 'Pepe Coin',
  symbol: 'PEPE',
  image: validateImage(PNG),
});
const job = (d: Draft): LaunchJob => ({
  draft: d,
  reviewedFee: { currency: ZERO, amountRaw: BigInt(FEE_RAW) },
  reviewedContracts: contractsOf(suite('tax')),
});

beforeEach(async () => {
  rpc = new MockRpc(8453);
  await rpc.start();
  rpc.codeAddresses.add(TOKEN.toLowerCase());
  wallet = new ViemWallet(KEY, [{ chainId: 8453, rpcUrl: rpc.url }]);
  await wallet.verifyChains();
  clock = new FakeClock();
  api = new FakeApi(clock);
  dir = tempDir();
  launcher = new Launcher({ api, catalog: new Catalog(api), wallet, history: new History(dir), log: silentLogger, sleep: clock.sleep, now: clock.now });
});

afterEach(async () => {
  await rpc.stop();
});

const statuses = async () => (await new History(dir).recent('launch', 20)).reverse().map((e) => e.status);

describe('a node that answers with an error is not necessarily a node that said no (round-2 review, HIGH)', () => {
  it('"internal error" for a transaction the node DID take: the lookup finds it, the launch confirms, one transaction only', async () => {
    rpc.failNextSend = { code: -32603, message: 'internal error' };
    rpc.failNextSendStillAccepts = true;
    const outcome = await launcher.run(job(draft()));
    expect(outcome.token).toBe(TOKEN);
    expect(rpc.sendCalls).toBe(1);
    expect(rpc.received).toHaveLength(1);
    expect(await statuses()).toEqual(['confirmed']);
  });

  it('a timeout-style error while the node does not show the transaction yet: unclear, locked, and the retry is refused (was: two launches)', async () => {
    rpc.autoMine = false;
    rpc.hideFromLookups = true; // a load-balanced backend that has not caught up
    rpc.failNextSend = { code: -32000, message: 'context deadline exceeded' };
    rpc.failNextSendStillAccepts = true;

    const d = draft();
    const first = await launcher.run(job(d)).catch((e) => e);
    expect(first).toBeInstanceOf(TxUnknownError);
    expect(first).not.toBeInstanceOf(BroadcastRejectedError);
    expect(rpc.received).toHaveLength(1); // the node really has the launch
    expect(await statuses()).toEqual(['unknown']);

    // the owner presses Launch again: nothing is sent
    await expect(launcher.run(job(d))).rejects.toBeInstanceOf(PendingLaunchError);
    await expect(launcher.run(job(draft()))).rejects.toBeInstanceOf(PendingLaunchError);
    expect(rpc.sendCalls).toBe(1);

    // the backend catches up and the launch mines
    rpc.hideFromLookups = false;
    rpc.mine();
    await expect(launcher.run(job(d))).rejects.toBeInstanceOf(DraftAlreadyLaunchedError); // late confirmation: this draft is done
    expect(rpc.received).toHaveLength(1);
    expect(await statuses()).toEqual(['confirmed']);
  });

  it.each([
    'nonce too low: next nonce 6, tx nonce 5',
    'replacement transaction underpriced',
    'insufficient funds for gas * price + value',
    'intrinsic gas too low',
    'max fee per gas less than block base fee',
    'exceeds block gas limit',
  ])('a definite refusal ("%s") is a failure that can be retried with the same draft', async (message) => {
    rpc.failNextSend = { code: -32000, message };
    const d = draft();
    const err = await launcher.run(job(d)).catch((e) => e);
    expect(err).toBeInstanceOf(BroadcastRejectedError);
    expect(err.message).toContain(message.split(':')[0]); // the node's own words survive
    expect(rpc.received).toHaveLength(0);
    expect(await statuses()).toEqual(['failed']);

    await expect(launcher.run(job(d))).resolves.toMatchObject({ token: TOKEN });
    expect(rpc.received).toHaveLength(1);
  });
});

describe('a receipt of another transaction is not our confirmation (round-2 review)', () => {
  it('a same-nonce replacement mined by someone else is reported as unclear and keeps the lock', async () => {
    rpc.autoMine = false;
    rpc.replaceNextTransaction = true;
    const d = draft();
    const err = await launcher.run(job(d)).catch((e) => e);
    expect(err).toBeInstanceOf(TxUnknownError);
    expect(err.message).toContain('digantikan');
    expect(err.message).toContain(rpc.replacement!.hash);
    expect(err.txHash).toBe(rpc.received[0]?.hash);
    expect(await statuses()).toEqual(['unknown']);
    expect(await wallet.transactionStatus(8453, err.txHash)).toBe('unknown'); // the bot's own hash never mined

    await expect(launcher.run(job(d))).rejects.toBeInstanceOf(PendingLaunchError);
  }, 30_000);
});

describe('the signer refuses absurd gas prices (round-2 review)', () => {
  it('signs nothing, sends nothing and records nothing when the RPC quotes a 500 gwei tip', async () => {
    rpc.priorityFee = 500_000_000_000;
    const err = await launcher.run(job(draft())).catch((e) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.message).toMatch(/Biaya gas maksimum .* ETH melebihi batas keamanan 0\.01 ETH/);
    expect(rpc.received).toHaveLength(0);
    expect(await statuses()).toEqual([]);
  });

  it('normal fees pass', async () => {
    await expect(launcher.run(job(draft()))).resolves.toMatchObject({ token: TOKEN });
  });
});

describe('the wallet must be idle (round-2 review)', () => {
  it('sees a transaction that waits in the mempool, and refuses to launch on top of it', async () => {
    rpc.autoMine = false;
    const signed = await wallet.sign(8453, { to: '0x0000000000000000000000000000000000002000', data: '0x', value: 0n });
    await wallet.broadcast(8453, signed);
    expect(await wallet.pendingTransactionCount(8453)).toBe(1);

    const err = await launcher.run(job(draft())).catch((e) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.message).toContain('1 transaksi yang belum terkonfirmasi');
    expect(rpc.received).toHaveLength(1); // only the one that was already there

    rpc.mine();
    expect(await wallet.pendingTransactionCount(8453)).toBe(0);
  });
});

describe('a reverted launch still reports its hash through the real signer', () => {
  it('reverts are recorded and can be retried', async () => {
    rpc.revertNext = true;
    const d = draft();
    await expect(launcher.run(job(d))).rejects.toBeInstanceOf(TxRevertedError);
    expect(await statuses()).toEqual(['reverted']);
    rpc.revertNext = false;
    await expect(launcher.run(job(d))).resolves.toMatchObject({ token: TOKEN });
  });
});
