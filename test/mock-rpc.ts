import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { keccak256, parseTransaction, recoverTransactionAddress, toHex, type Hex, type TransactionSerializable } from 'viem';

export interface DecodedTx {
  hash: Hex;
  raw: Hex;
  tx: TransactionSerializable;
  from: string;
}

/** Minimal JSON-RPC node: enough for viem to estimate, sign, broadcast and confirm a transaction. */
export class MockRpc {
  chainId: number;
  estimate = 100_000n;
  estimateError: { code: number; message: string } | null = null;
  balance = 10n ** 18n;
  erc20Balance = 123n;
  codeAddresses = new Set<string>();
  received: DecodedTx[] = [];
  estimateParams: unknown[] = [];
  private readonly receipts = new Map<string, { blockNumber: number; status: '0x0' | '0x1' }>();
  private server!: Server;
  url = '';
  revertNext = false;
  block = 100;
  /** Every eth_sendRawTransaction request that reached the node (also failed and dropped ones). */
  sendCalls = 0;
  /** The node accepts the next transaction but the connection dies before the reply arrives. */
  dropNextSendReply = false;
  /** The next eth_sendRawTransaction is refused with a JSON-RPC error. */
  failNextSend: { code: number; message: string } | null = null;
  /** When false, accepted transactions stay pending (no receipt) until mine() is called. */
  autoMine = true;
  private readonly mined = new Set<string>();

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        const payload = JSON.parse(body);
        const respond = async (call: { id: number; method: string; params?: unknown[] }) => {
          try {
            if (call.method === 'eth_sendRawTransaction') {
              this.sendCalls++;
              if (this.failNextSend) {
                const fault = this.failNextSend;
                this.failNextSend = null;
                return { jsonrpc: '2.0', id: call.id, error: { code: fault.code, message: fault.message } };
              }
            }
            const result = await this.handle(call.method, call.params ?? []);
            if (call.method === 'eth_sendRawTransaction' && this.dropNextSendReply) {
              this.dropNextSendReply = false;
              return null; // accepted, but no reply will be sent
            }
            return { jsonrpc: '2.0', id: call.id, result };
          } catch (err) {
            const e = err as { code?: number; message: string };
            return { jsonrpc: '2.0', id: call.id, error: { code: e.code ?? -32000, message: e.message } };
          }
        };
        const out = Array.isArray(payload) ? await Promise.all(payload.map(respond)) : await respond(payload);
        if (out === null) {
          req.socket.destroy();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Includes every pending transaction in a block. */
  mine(): void {
    for (const item of this.received) this.mined.add(item.hash);
    this.block++;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private blockObject(number: number) {
    return {
      number: toHex(number),
      hash: keccak256(toHex(number)),
      parentHash: keccak256(toHex(number - 1)),
      timestamp: toHex(1_700_000_000 + number),
      gasLimit: toHex(30_000_000),
      gasUsed: toHex(1_000_000),
      baseFeePerGas: toHex(1_000_000_000),
      miner: '0x0000000000000000000000000000000000000000',
      nonce: '0x0000000000000000',
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      logsBloom: `0x${'00'.repeat(256)}`,
      sha3Uncles: keccak256('0x'),
      stateRoot: keccak256('0x01'),
      receiptsRoot: keccak256('0x02'),
      transactionsRoot: keccak256('0x03'),
      size: '0x100',
      uncles: [],
      transactions: [],
    };
  }

  private async handle(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'eth_chainId':
        return toHex(this.chainId);
      case 'eth_blockNumber':
        return toHex(this.block);
      case 'eth_getBlockByNumber': {
        const tag = params[0] as string;
        return this.blockObject(tag === 'latest' || tag === 'pending' ? this.block : Number(BigInt(tag)));
      }
      case 'eth_getTransactionCount':
        return toHex(5 + this.received.length);
      case 'eth_gasPrice':
        return toHex(2_000_000_000);
      case 'eth_maxPriorityFeePerGas':
        return toHex(1_000_000_000);
      case 'eth_estimateGas':
        this.estimateParams.push(params[0]);
        if (this.estimateError) throw this.estimateError;
        return toHex(this.estimate);
      case 'eth_getBalance':
        return toHex(this.balance);
      case 'eth_getCode':
        return this.codeAddresses.has((params[0] as string).toLowerCase()) ? '0x6080' : '0x';
      case 'eth_call':
        return toHex(this.erc20Balance, { size: 32 });
      case 'eth_sendRawTransaction': {
        const raw = params[0] as Hex;
        const tx = parseTransaction(raw);
        const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
        const hash = keccak256(raw);
        this.received.push({ hash, raw, tx, from });
        this.receipts.set(hash, { blockNumber: this.block + 1, status: this.revertNext ? '0x0' : '0x1' });
        if (this.autoMine) this.mined.add(hash);
        return hash;
      }
      case 'eth_getTransactionByHash': {
        const found = this.received.find((r) => r.hash === params[0]);
        if (!found) return null;
        const receipt = this.receipts.get(found.hash)!;
        const isMined = this.mined.has(found.hash);
        return {
          hash: found.hash,
          nonce: toHex(found.tx.nonce ?? 0),
          blockHash: isMined ? keccak256(toHex(receipt.blockNumber)) : null,
          blockNumber: isMined ? toHex(receipt.blockNumber) : null,
          transactionIndex: isMined ? '0x0' : null,
          from: found.from,
          to: found.tx.to,
          value: toHex(found.tx.value ?? 0n),
          gas: toHex(found.tx.gas ?? 0n),
          gasPrice: toHex(2_000_000_000),
          input: found.tx.data ?? '0x',
          type: '0x2',
          chainId: toHex(this.chainId),
          v: '0x0',
          r: '0x1',
          s: '0x1',
        };
      }
      case 'eth_getTransactionReceipt': {
        const found = this.received.find((r) => r.hash === params[0]);
        const receipt = found && this.receipts.get(found.hash);
        if (!found || !receipt || !this.mined.has(found.hash)) return null;
        return {
          transactionHash: found.hash,
          transactionIndex: '0x0',
          blockHash: keccak256(toHex(receipt.blockNumber)),
          blockNumber: toHex(receipt.blockNumber),
          from: found.from,
          to: found.tx.to,
          cumulativeGasUsed: toHex(90_000),
          gasUsed: toHex(90_000),
          effectiveGasPrice: toHex(2_000_000_000),
          contractAddress: null,
          logs: [],
          logsBloom: `0x${'00'.repeat(256)}`,
          status: receipt.status,
          type: '0x2',
        };
      }
      default:
        throw new Error(`MockRpc: unsupported method ${method}`);
    }
  }
}
