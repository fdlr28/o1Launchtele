import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { encodeFunctionData, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FEE_RAW } from './fakes.js';
import { FACTORY, TOKEN, configFor } from './fixtures.js';
import { launchPrepareRequestSchema } from './openapi-schema.js';
import { PNG_BYTES } from './bot-harness.js';

/**
 * Local stand-ins for Telegram and the o1 API (the EVM node lives in mock-rpc.ts). Used by the
 * end-to-end tests that run real processes: the bot, `npm run doctor` and the VPS installer.
 */

// Well-known Hardhat/Anvil test key #0 (never holds real funds).
export const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const WALLET = privateKeyToAccount(PRIVATE_KEY).address;
export const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
export const API_KEY = 'o1_launch_abcdef12_E2eSecretValue-xyz';
export const OWNER = 42;

export function json(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

export function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

// ---------------------------------------------------------------------------------------------
export class MockTelegram {
  calls: Array<{ method: string; payload: Record<string, any> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  polls = 0;
  url = '';
  private server!: Server;
  private queue: unknown[] = [];
  private wake: Array<() => void> = [];
  private nextMessageId = 500;
  private updateId = 1;
  private messageId = 1;
  lastPanelId = 0;
  /** Answer getUpdates with this Telegram error (409: another instance polls the same token). */
  getUpdatesFault: { code: number; description: string } | null = null;

  async start() {
    this.server = createServer(async (req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.startsWith(`/file/bot${BOT_TOKEN}/`)) {
        res.writeHead(200, { 'content-type': 'image/png' });
        return void res.end(Buffer.from(PNG_BYTES));
      }
      const match = new RegExp(`^/bot${BOT_TOKEN}/(\\w+)`).exec(url);
      if (!match) return json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
      const method = match[1] as string;
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};

      if (method === 'getUpdates') {
        this.polls++;
        if (this.getUpdatesFault) return json(res, this.getUpdatesFault.code, { ok: false, error_code: this.getUpdatesFault.code, description: this.getUpdatesFault.description });
        const offset = Number(payload.offset ?? 0);
        const pick = () => this.queue.filter((u) => (u as { update_id: number }).update_id >= offset);
        if (pick().length === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 700);
            this.wake.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        return json(res, 200, { ok: true, result: pick() });
      }

      this.calls.push({ method, payload });
      switch (method) {
        case 'getMe':
          return json(res, 200, { ok: true, result: { id: 1, is_bot: true, first_name: 'Bot', username: 'e2e_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } });
        case 'sendMessage': {
          const id = this.nextMessageId++;
          // The control panel is the message with the inline keyboard; plain replies (/dismiss, /wallet...) are not.
          if (payload.reply_markup) this.lastPanelId = id;
          return json(res, 200, { ok: true, result: { message_id: id, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text } });
        }
        case 'getFile':
          return json(res, 200, { ok: true, result: { file_id: payload.file_id, file_unique_id: 'u', file_size: PNG_BYTES.length, file_path: 'photos/a.png' } });
        default:
          return json(res, 200, { ok: true, result: true });
      }
    });
    this.url = await listen(this.server);
  }

  async stop() {
    this.wake.forEach((w) => w());
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private push(update: Record<string, unknown>) {
    this.queue.push({ update_id: this.updateId++, ...update });
    this.wake.splice(0).forEach((w) => w());
  }

  private from = { id: OWNER, is_bot: false, first_name: 'T' };
  private chat = { id: OWNER, type: 'private', first_name: 'T' };

  text(text: string, entities?: unknown[]) {
    this.push({ message: { message_id: this.messageId++, date: 0, chat: this.chat, from: this.from, text, ...(entities ? { entities } : {}) } });
  }
  command(name: string) {
    this.text(`/${name}`, [{ type: 'bot_command', offset: 0, length: name.length + 1 }]);
  }
  photo(fileId: string) {
    this.push({ message: { message_id: this.messageId++, date: 0, chat: this.chat, from: this.from, photo: [{ file_id: fileId, file_unique_id: 'p', width: 100, height: 100, file_size: PNG_BYTES.length }] } });
  }
  press(data: string) {
    this.push({ callback_query: { id: `cb${this.updateId}`, from: this.from, chat_instance: 'ci', data, message: { message_id: this.lastPanelId, date: 0, chat: this.chat, text: 'panel' } } });
  }

  panelText(): string {
    const last = [...this.calls].reverse().find((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
    return String(last?.payload.text ?? '');
  }
}

// ---------------------------------------------------------------------------------------------
export class MockO1 {
  url = '';
  bodies: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Array<IncomingMessage['headers']> = [];
  configHits = 0;
  /** Delays every /launches/prepare response (the real API uploads to IPFS and mines an address). */
  prepareDelayMs = 0;
  /** The native creation fee in wei: reported by /config and required by the plans. */
  feeRaw = FEE_RAW;
  /** When set, /config reports the creation fee in this token instead of the native currency. */
  feeToken: { address: string; symbol: string; decimals: number } | null = null;
  private server!: Server;
  private validate = (() => {
    const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: Ajv2020) => void;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    return ajv.compile(launchPrepareRequestSchema);
  })();

  async start() {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const meta = { request_id: 'req_e2e', generated_at: new Date().toISOString(), warnings: [] };
      if (req.headers['x-api-key'] !== API_KEY) {
        return json(res, 401, { status: 401, code: 'invalid_api_key', title: 'Invalid API key', request_id: 'req_e2e' }, 'application/problem+json');
      }

      if (req.method === 'GET' && url.pathname === '/v1/config') {
        this.configHits++;
        const product = url.searchParams.get('launch_product') === 'tax' ? 'tax' : 'non-tax';
        const cfg = configFor(product);
        cfg.suites![0]!.creation_fee = this.feeToken
          ? { amount_raw: this.feeRaw, currency: this.feeToken.address, symbol: this.feeToken.symbol, decimals: this.feeToken.decimals }
          : { amount_raw: this.feeRaw, currency: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 };
        return json(res, 200, { data: cfg, meta });
      }

      if (req.method === 'POST' && url.pathname === '/v1/launches/prepare') {
        const body = JSON.parse(await readBody(req));
        this.bodies.push(body);
        this.headers.push(req.headers);
        if (this.prepareDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.prepareDelayMs));
        if (!this.validate(body)) {
          return json(res, 400, { status: 400, code: 'invalid_request', title: 'Invalid', detail: JSON.stringify(this.validate.errors), request_id: 'req_e2e' }, 'application/problem+json');
        }
        const now = Date.now();
        return json(res, 200, {
          data: {
            chain_id: body.chain_id,
            actor: body.creator,
            prepared_at: new Date(now).toISOString(),
            expires_at: new Date(now + 30 * 60_000).toISOString(),
            observed_block: '100',
            issues: [],
            steps: this.feeToken
              ? [
                  {
                    id: 'approve-fee', kind: 'transaction', label: 'Approve the creation fee', depends_on: [],
                    transaction: {
                      chain_id: body.chain_id, from: body.creator, to: this.feeToken.address, value: '0',
                      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [FACTORY, BigInt(this.feeRaw)] }),
                    },
                    simulation: { status: 'succeeded', block_number: '100' },
                  },
                  {
                    id: 'create-launch', kind: 'transaction', label: 'Create launch', depends_on: ['approve-fee'],
                    transaction: { chain_id: body.chain_id, from: body.creator, to: FACTORY, data: '0xabcdef12', value: '0' },
                    simulation: { status: 'succeeded', block_number: '100' },
                  },
                ]
              : [
                  {
                    id: 'create-launch', kind: 'transaction', label: 'Create launch', depends_on: [],
                    transaction: { chain_id: body.chain_id, from: body.creator, to: FACTORY, data: '0xabcdef12', value: this.feeRaw },
                    simulation: { status: 'succeeded', block_number: '100' },
                  },
                ],
            predicted_token_address: TOKEN,
            suite_id: 'e2e',
            metadata_uri: 'ipfs://meta',
            image_url: null,
          },
          meta,
        });
      }
      return json(res, 404, { status: 404, code: 'not_found', title: 'Not found', request_id: 'req_e2e' }, 'application/problem+json');
    });
    this.url = await listen(this.server);
  }

  async stop() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
