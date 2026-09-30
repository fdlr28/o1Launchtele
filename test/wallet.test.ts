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
  rpc.tokens.set(USDC.toLowerCase(), 6);
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

describe('what counts as a refusal (round-2 review)', () => {
  const definite = [
    [-32000, 'nonce too low: next nonce 6, tx nonce 5'],
    [-32000, 'replacement transaction underpriced'],
    [-32000, 'transaction underpriced'],
    [-32000, 'insufficient funds for gas * price + value: address 0x1 have 1 want 2'],
    [-32000, 'intrinsic gas too low: have 20000, want 53000'],
    [-32000, 'exceeds block gas limit'],
    [-32000, 'max fee per gas less than block base fee: maxFeePerGas: 1, baseFee: 2'],
    [-32003, 'Insufficient funds for gas * price + value'],
    [-32000, 'invalid sender'],
    [-32000, 'oversized data'],
  ] as const;
  const uncertain = [
    [-32603, 'internal error'],
    [-32000, 'timeout'],
    [-32000, 'context deadline exceeded'],
    [-32005, 'rate limit exceeded'],
    [-32000, 'header not found'],
    [-32000, 'server busy'],
    [-32001, 'resource not found'],
    [-32000, 'something new that no list has heard of'],
  ] as const;

  it.each(definite)('%i "%s" proves the node did not take the transaction', async (code, message) => {
    rpc.failNextSend = { code, message };
    const signed = await wallet.sign(8453, TX);
    const err = await wallet.broadcast(8453, signed).catch((e) => e);
    expect(err).toBeInstanceOf(BroadcastRejectedError);
    expect(err.message).toContain(message.split(':')[0]!.slice(0, 20)); // the node's own words reach the owner
  });

  it.each(uncertain)('%i "%s" may be an answer for a transaction that WAS taken: uncertain', async (code, message) => {
    rpc.failNextSend = { code, message };
    rpc.failNextSendStillAccepts = true;
    const signed = await wallet.sign(8453, TX);
    const err = await wallet.broadcast(8453, signed).catch((e) => e);
    expect(err).toBeInstanceOf(BroadcastUncertainError);
    expect(err).not.toBeInstanceOf(BroadcastRejectedError);
    expect(rpc.received).toHaveLength(1); // ... and it really was taken
    expect(await wallet.transactionStatus(8453, signed.hash)).not.toBe('unknown');
  });

  it('never puts the RPC URL (which may carry a key) into the reason', async () => {
    rpc.failNextSend = { code: -32603, message: 'internal error' };
    const signed = await wallet.sign(8453, TX);
    const err = await wallet.broadcast(8453, signed).catch((e) => e);
    expect(err.message).not.toContain(rpc.url);
    expect(err.message).not.toContain('Request body');
  });
});

describe('gas cost is capped (round-2 review)', () => {
  it('refuses to sign when the RPC quotes a fee that could burn the wallet, and says so', async () => {
    rpc.priorityFee = 500_000_000_000; // 500 gwei
    const err = await wallet.sign(8453, TX).catch((e) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.message).toMatch(/Biaya gas maksimum 0\.0\d+ ETH melebihi batas keamanan 0\.01 ETH/);
    expect(rpc.received).toHaveLength(0);
  });

  it('signs at ordinary fees, also on a busy chain', async () => {
    rpc.priorityFee = 50_000_000_000; // 50 gwei: 115k gas x ~51 gwei = 0.006 ETH, under the 0.01 ETH cap
    await expect(wallet.sign(8453, TX)).resolves.toBeDefined();
  });
});

describe('what the chain says about tokens (round-3 review)', () => {
  it('reads decimals from the token contract, and remembers them', async () => {
    expect(await wallet.erc20Decimals(8453, USDC)).toBe(6);
    rpc.tokens.set(USDC.toLowerCase(), 18); // changes on the node ...
    expect(await wallet.erc20Decimals(8453, USDC)).toBe(6); // ... but decimals never change, so the answer is kept
    await expect(wallet.erc20Decimals(8453, FACTORY)).rejects.toThrow(); // not a token: no answer at all
  });

  it('recognises an ERC-20 by its behaviour, and a factory or router as not one', async () => {
    expect(await wallet.isTokenLike(8453, USDC)).toBe(true);
    expect(await wallet.isTokenLike(8453, FACTORY)).toBe(false); // answers nothing to decimals()
    expect(await wallet.isTokenLike(8453, '0x00000000000000000000000000000000000000ff')).toBe(false);
  });

  it('cannot tell when the RPC itself is unreachable, and says so instead of answering "no"', async () => {
    await rpc.stop();
    await expect(wallet.isTokenLike(8453, FACTORY)).rejects.toThrow();
    await rpc.start();
  });

  it('honours the owner\'s own gas ceiling for a chain', async () => {
    const strict = new ViemWallet(KEY, [{ chainId: 8453, rpcUrl: rpc.url, maxGasCostWei: 1_000n }]);
    await strict.verifyChains();
    const err = await strict.sign(8453, TX).catch((e) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.message).toContain('melebihi batas keamanan');
    const generous = new ViemWallet(KEY, [{ chainId: 8453, rpcUrl: rpc.url, maxGasCostWei: 10n ** 20n }]);
    await generous.verifyChains();
    rpc.priorityFee = 500_000_000_000; // refused by the built-in ceiling, allowed by the owner's
    await expect(generous.sign(8453, TX)).resolves.toBeDefined();
  });
});

describe('what waits in the mempool', () => {
  it('counts pending transactions of the wallet: pending nonce minus confirmed nonce', async () => {
    expect(await wallet.pendingTransactionCount(8453)).toBe(0);
    rpc.autoMine = false;
    await wallet.broadcast(8453, await wallet.sign(8453, TX));
    expect(await wallet.pendingTransactionCount(8453)).toBe(1);
    rpc.mine();
    expect(await wallet.pendingTransactionCount(8453)).toBe(0);
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
    expect(await wallet.waitForReceipt(8453, ok.hash, 10_000)).toMatchObject({ status: 'success', transactionHash: ok.hash });

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
