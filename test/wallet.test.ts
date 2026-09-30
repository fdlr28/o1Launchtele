import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import { BroadcastRejectedError, BroadcastUncertainError, ViemWallet } from '../src/wallet/wallet.js';
import { FACTORY, TOKEN, USDC } from './fixtures.js';
import { MockRpc } from './mock-rpc.js';

// Well-known Hardhat/Anvil test key #0. Never holds real funds.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ACCOUNT = privateKeyToAccount(KEY);
const TX = { to: FACTORY, data: '0xdeadbeef', value: 1_000_000_000_000_000n } as const;

let rpc: MockRpc;
let wallet: ViemWallet;

beforeEach(async () => {
  rpc = new MockRpc(8453);
  await rpc.start();
  wallet = new ViemWallet(KEY, [{ chainId: 8453, rpcUrl: rpc.url }]);
  await wallet.verifyChains();
});

afterEach(async () => {
  await rpc.stop();
});

describe('ViemWallet against a mock RPC', () => {
  it('derives its address from the key', () => {
    expect(wallet.address).toBe(ACCOUNT.address);
  });

  it('enables a chain only when the RPC reports the expected chain id', async () => {
    expect(wallet.enabledChains()).toEqual([8453]);

    const wrong = new MockRpc(1);
    await wrong.start();
    try {
      const other = new ViemWallet(KEY, [{ chainId: 8453, rpcUrl: wrong.url }]);
      const [check] = await other.verifyChains();
      expect(check).toMatchObject({ chainId: 8453, ok: false });
      expect(check?.error).toMatch(/chain id 1/);
      expect(other.enabledChains()).toEqual([]);
      await expect(other.sign(8453, TX)).rejects.toThrow(UserFacingError);
    } finally {
      await wrong.stop();
    }
  });

  it('reports an unreachable RPC without throwing', async () => {
    const dead = new ViemWallet(KEY, [{ chainId: 8453, rpcUrl: 'http://127.0.0.1:1' }]);
    const [check] = await dead.verifyChains();
    expect(check?.ok).toBe(false);
    expect(dead.enabledChains()).toEqual([]);
  });
});

describe('sign then broadcast', () => {
  it('signs locally and knows the hash before anything is sent', async () => {
    const signed = await wallet.sign(8453, TX);
    expect(signed.hash).toBe(keccak256(signed.raw));
    expect(rpc.received).toHaveLength(0); // nothing was broadcast
    expect(rpc.sendCalls).toBe(0);

    await wallet.broadcast(8453, signed);
    expect(rpc.sendCalls).toBe(1);
    expect(rpc.received).toHaveLength(1);
    expect(rpc.received[0]?.hash).toBe(signed.hash); // the node's hash equals the pre-computed one
  });

  it('broadcasts exactly the requested transaction with a gas buffer', async () => {
    const signed = await wallet.sign(8453, TX);
    await wallet.broadcast(8453, signed);

    const sent = rpc.received[0]!;
    expect(sent.from).toBe(ACCOUNT.address);
    expect(sent.tx.to?.toLowerCase()).toBe(FACTORY.toLowerCase());
    expect(sent.tx.data).toBe('0xdeadbeef');
    expect(sent.tx.value).toBe(1_000_000_000_000_000n);
    expect(sent.tx.chainId).toBe(8453);
    expect(sent.tx.gas).toBe(115_000n); // estimate 100_000 * 115%
    const estimated = rpc.estimateParams[0] as { from: string; data: string };
    expect(estimated.from.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
    expect(estimated.data).toBe('0xdeadbeef');
  });

  it('turns a reverting estimate into a readable error and signs nothing', async () => {
    rpc.estimateError = { code: 3, message: 'execution reverted: LaunchExpired' };
    const err = await wallet.sign(8453, { ...TX, data: '0x01', value: 0n }).catch((e) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.message).toMatch(/Estimasi gas gagal/);
    expect(rpc.received).toHaveLength(0);
  });

  it('a node error is a definitive rejection, sent once, and the hash stays unknown', async () => {
    rpc.failNextSend = { code: -32000, message: 'nonce too low' };
    const signed = await wallet.sign(8453, TX);
    await expect(wallet.broadcast(8453, signed)).rejects.toBeInstanceOf(BroadcastRejectedError);
    expect(rpc.sendCalls).toBe(1); // no hidden transport retry
    expect(await wallet.transactionStatus(8453, signed.hash)).toBe('unknown');
  });

  it('"already known" is not a rejection: the node has our transaction', async () => {
    rpc.failNextSend = { code: -32000, message: 'already known' };
    const signed = await wallet.sign(8453, TX);
    await expect(wallet.broadcast(8453, signed)).rejects.toBeInstanceOf(BroadcastUncertainError);
  });

  it('a lost reply is reported as uncertain, is never retried, and the tx can be found by hash', async () => {
    rpc.dropNextSendReply = true; // the node accepts the transaction, then the connection dies
    const signed = await wallet.sign(8453, TX);
    await expect(wallet.broadcast(8453, signed)).rejects.toBeInstanceOf(BroadcastUncertainError);
    expect(rpc.sendCalls).toBe(1); // a hidden retry would have resent (and, on a real node, could double-spend the nonce)
    expect(rpc.received).toHaveLength(1);
    expect(await wallet.transactionStatus(8453, signed.hash)).toBe('success');
  });

  it('an unreachable node during broadcast is uncertain, not rejected', async () => {
    const signed = await wallet.sign(8453, TX);
    await rpc.stop();
    await expect(wallet.broadcast(8453, signed)).rejects.toBeInstanceOf(BroadcastUncertainError);
    await rpc.start(); // afterEach stops it again
  });
});

describe('transaction status and receipts', () => {
  it('reports pending, success, reverted and unknown', async () => {
    rpc.autoMine = false;
    const pending = await wallet.sign(8453, TX);
    await wallet.broadcast(8453, pending);
    expect(await wallet.transactionStatus(8453, pending.hash)).toBe('pending');
    rpc.mine();
    expect(await wallet.transactionStatus(8453, pending.hash)).toBe('success');

    rpc.revertNext = true;
    const bad = await wallet.sign(8453, { ...TX, data: '0x02' });
    await wallet.broadcast(8453, bad);
    rpc.mine();
    expect(await wallet.transactionStatus(8453, bad.hash)).toBe('reverted');

    expect(await wallet.transactionStatus(8453, `0x${'ab'.repeat(32)}`)).toBe('unknown');
  });

  it('waits for a receipt and reports success or revert', async () => {
    const ok = await wallet.sign(8453, { ...TX, data: '0x01' });
    await wallet.broadcast(8453, ok);
    expect(await wallet.waitForReceipt(8453, ok.hash, 10_000)).toMatchObject({ status: 'success' });

    rpc.revertNext = true;
    const bad = await wallet.sign(8453, { ...TX, data: '0x02' });
    await wallet.broadcast(8453, bad);
    expect(await wallet.waitForReceipt(8453, bad.hash, 10_000)).toMatchObject({ status: 'reverted' });
  });

  it('times out instead of hanging when no receipt ever arrives', async () => {
    await expect(wallet.waitForReceipt(8453, `0x${'ab'.repeat(32)}`, 1_500)).rejects.toThrow();
  }, 10_000);

  it('reads balances, code and block timestamps', async () => {
    expect(await wallet.nativeBalance(8453)).toBe(10n ** 18n);
    expect(await wallet.erc20Balance(8453, USDC)).toBe(123n);
    expect(await wallet.hasCode(8453, TOKEN)).toBe(false);
    rpc.codeAddresses.add(TOKEN.toLowerCase());
    expect(await wallet.hasCode(8453, TOKEN)).toBe(true);
    expect(await wallet.blockTimestamp(8453)).toBe(1_700_000_100);
    expect(await wallet.blockTimestamp(8453, 42n)).toBe(1_700_000_042);
  });

  it('refuses chains it was not configured for', async () => {
    await expect(wallet.nativeBalance(56)).rejects.toThrow(/RPC_URL_56/);
  });

  it('signs EIP-712 payloads', async () => {
    const signature = await wallet.signTypedData(8453, {
      domain: { name: 'Test', chainId: 8453 },
      types: { Msg: [{ name: 'n', type: 'uint256' }] },
      primaryType: 'Msg',
      message: { n: 1n },
    });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});
