import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import { ViemWallet } from '../src/wallet/wallet.js';
import { FACTORY, TOKEN, USDC } from './fixtures.js';
import { MockRpc } from './mock-rpc.js';

// Well-known Hardhat/Anvil test key #0. Never holds real funds.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ACCOUNT = privateKeyToAccount(KEY);

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
      await expect(other.send(8453, { to: FACTORY, data: '0x', value: 0n })).rejects.toThrow(UserFacingError);
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

  it('signs and broadcasts exactly the requested transaction with a gas buffer', async () => {
    const hash = await wallet.send(8453, { to: FACTORY, data: '0xdeadbeef', value: 1_000_000_000_000_000n });

    expect(rpc.received).toHaveLength(1);
    const sent = rpc.received[0]!;
    expect(sent.hash).toBe(hash);
    expect(sent.from).toBe(ACCOUNT.address);
    expect(sent.tx.to?.toLowerCase()).toBe(FACTORY.toLowerCase());
    expect(sent.tx.data).toBe('0xdeadbeef');
    expect(sent.tx.value).toBe(1_000_000_000_000_000n);
    expect(sent.tx.chainId).toBe(8453);
    // estimate 100_000 * 115% = 115_000
    expect(sent.tx.gas).toBe(115_000n);
    // the estimate was made for the same call from our wallet
    const estimated = rpc.estimateParams[0] as { from: string; data: string };
    expect(estimated.from.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
    expect(estimated.data).toBe('0xdeadbeef');
  });

  it('turns a reverting estimate into a readable error and broadcasts nothing', async () => {
    rpc.estimateError = { code: 3, message: 'execution reverted: LaunchExpired' };
    const err = await wallet.send(8453, { to: FACTORY, data: '0x01', value: 0n }).catch((e) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.message).toMatch(/Estimasi gas gagal/);
    expect(rpc.received).toHaveLength(0);
  });

  it('waits for a receipt and reports success or revert', async () => {
    const ok = await wallet.send(8453, { to: FACTORY, data: '0x01', value: 0n });
    expect(await wallet.waitForReceipt(8453, ok, 10_000)).toMatchObject({ status: 'success' });

    rpc.revertNext = true;
    const bad = await wallet.send(8453, { to: FACTORY, data: '0x02', value: 0n });
    expect(await wallet.waitForReceipt(8453, bad, 10_000)).toMatchObject({ status: 'reverted' });
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
