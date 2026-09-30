import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { CHAINS } from '../chains.js';
import { UserFacingError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { SafeTx } from '../services/guard.js';

export interface Receipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
}

export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Everything the launcher needs from a signer + RPC, so it can be faked in tests. */
export interface Wallet {
  readonly address: Address;
  /** Chains whose RPC was reachable and reported the expected chain id. */
  enabledChains(): number[];
  nativeBalance(chainId: number): Promise<bigint>;
  erc20Balance(chainId: number, token: Address): Promise<bigint>;
  /** Estimates gas (+ buffer), signs and broadcasts. Never retries a broadcast. */
  send(chainId: number, tx: SafeTx): Promise<Hash>;
  /** Throws when the timeout elapses; the transaction may still confirm later. */
  waitForReceipt(chainId: number, hash: Hash, timeoutMs?: number): Promise<Receipt>;
  hasCode(chainId: number, address: Address): Promise<boolean>;
  /** Unix seconds of a block (latest when omitted). */
  blockTimestamp(chainId: number, blockNumber?: bigint): Promise<number>;
  signTypedData(chainId: number, payload: TypedDataPayload): Promise<Hex>;
}

export interface ChainRuntime {
  chainId: number;
  rpcUrl: string;
}

export interface ChainCheck {
  chainId: number;
  ok: boolean;
  error?: string;
}

/** Extra gas on top of eth_estimateGas: covers state that shifts between estimate and inclusion. */
const GAS_BUFFER_NUM = 115n;
const GAS_BUFFER_DEN = 100n;

export class ViemWallet implements Wallet {
  readonly address: Address;
  private readonly account: PrivateKeyAccount;
  private readonly chains = new Map<number, Chain>();
  private readonly publicClients = new Map<number, PublicClient>();
  private readonly walletClients = new Map<number, WalletClient>();
  private readonly ready = new Set<number>();

  constructor(
    privateKey: Hex,
    runtimes: ChainRuntime[],
    private readonly log?: Logger,
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
    for (const runtime of runtimes) {
      const info = CHAINS[runtime.chainId];
      const chain = defineChain({
        id: runtime.chainId,
        name: info?.name ?? `Chain ${runtime.chainId}`,
        nativeCurrency: {
          name: info?.nativeSymbol ?? 'Native',
          symbol: info?.nativeSymbol ?? 'NATIVE',
          decimals: info?.nativeDecimals ?? 18,
        },
        rpcUrls: { default: { http: [runtime.rpcUrl] } },
      });
      const transport = http(runtime.rpcUrl, { timeout: 20_000, retryCount: 2, retryDelay: 400 });
      this.chains.set(runtime.chainId, chain);
      this.publicClients.set(runtime.chainId, createPublicClient({ chain, transport }));
      this.walletClients.set(runtime.chainId, createWalletClient({ chain, transport, account: this.account }));
    }
  }

  /**
   * viem does not compare the RPC's chain id with the configured one for local accounts,
   * so check it once up front: signing for the wrong network must be impossible.
   */
  async verifyChains(): Promise<ChainCheck[]> {
    const checks = await Promise.all(
      [...this.chains.keys()].map(async (chainId): Promise<ChainCheck> => {
        try {
          const actual = await this.pub(chainId).getChainId();
          if (actual !== chainId) return { chainId, ok: false, error: `RPC mengembalikan chain id ${actual}, seharusnya ${chainId}` };
          this.ready.add(chainId);
          return { chainId, ok: true };
        } catch (err) {
          return { chainId, ok: false, error: err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err) };
        }
      }),
    );
    return checks;
  }

  enabledChains(): number[] {
    return [...this.ready];
  }

  async nativeBalance(chainId: number): Promise<bigint> {
    return this.pub(chainId).getBalance({ address: this.address });
  }

  async erc20Balance(chainId: number, token: Address): Promise<bigint> {
    return this.pub(chainId).readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [this.address] });
  }

  async send(chainId: number, tx: SafeTx): Promise<Hash> {
    this.assertReady(chainId);
    const pub = this.pub(chainId);
    let gas: bigint;
    try {
      const estimate = await pub.estimateGas({ account: this.address, to: tx.to, data: tx.data, value: tx.value });
      gas = (estimate * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
    } catch (err) {
      const reason = (err as { shortMessage?: string }).shortMessage ?? (err instanceof Error ? err.message : String(err));
      throw new UserFacingError(`Estimasi gas gagal (transaksi kemungkinan akan revert): ${reason.split('\n')[0]}`, { cause: err });
    }
    const client = this.walletClients.get(chainId);
    const chain = this.chains.get(chainId);
    if (!client || !chain) throw new UserFacingError(`Chain ${chainId} tidak dikonfigurasi.`);
    this.log?.debug(`sending tx on chain ${chainId} to ${tx.to} (gas ${gas})`);
    return client.sendTransaction({ account: this.account, chain, to: tx.to, data: tx.data, value: tx.value, gas });
  }

  async waitForReceipt(chainId: number, hash: Hash, timeoutMs = 180_000): Promise<Receipt> {
    const receipt = await this.pub(chainId).waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1000 });
    return { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  }

  async hasCode(chainId: number, address: Address): Promise<boolean> {
    const code = await this.pub(chainId).getCode({ address });
    return !!code && code !== '0x';
  }

  async blockTimestamp(chainId: number, blockNumber?: bigint): Promise<number> {
    const block = await this.pub(chainId).getBlock(blockNumber === undefined ? undefined : { blockNumber });
    return Number(block.timestamp);
  }

  async signTypedData(chainId: number, payload: TypedDataPayload): Promise<Hex> {
    this.assertReady(chainId);
    return this.account.signTypedData({
      domain: payload.domain,
      types: payload.types,
      primaryType: payload.primaryType,
      message: payload.message,
    } as Parameters<PrivateKeyAccount['signTypedData']>[0]);
  }

  private assertReady(chainId: number): void {
    if (!this.ready.has(chainId)) {
      throw new UserFacingError(`RPC untuk chain ${chainId} belum terverifikasi. Cek RPC_URL_${chainId} lalu restart bot.`);
    }
  }

  private pub(chainId: number): PublicClient {
    const client = this.publicClients.get(chainId);
    if (!client) throw new UserFacingError(`Chain ${chainId} tidak dikonfigurasi (RPC_URL_${chainId} belum diisi).`);
    return client;
  }
}
