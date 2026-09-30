import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FEE_RAW, tempDir } from './fakes.js';
import { FACTORY, TOKEN, configFor } from './fixtures.js';
import { MockRpc } from './mock-rpc.js';
import { launchPrepareRequestSchema } from './openapi-schema.js';
import { PNG_BYTES } from './bot-harness.js';

/**
 * Runs the real process (src/index.ts) against three local servers that stand in for Telegram,
 * the o1 API and an EVM node. Nothing in the bot is faked: this exercises the real HTTP client,
 * long polling, viem signing/broadcasting and the wiring in index.ts.
 */

// Well-known Hardhat/Anvil test key #0 (never holds real funds).
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WALLET = privateKeyToAccount(PRIVATE_KEY).address;
const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const API_KEY = 'o1_launch_abcdef12_E2eSecretValue-xyz';
const OWNER = 42;

function json(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

// ---------------------------------------------------------------------------------------------
class MockTelegram {
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
          this.lastPanelId = id;
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
class MockO1 {
  url = '';
  bodies: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Array<IncomingMessage['headers']> = [];
  configHits = 0;
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
        return json(res, 200, { data: configFor(product), meta });
      }

      if (req.method === 'POST' && url.pathname === '/v1/launches/prepare') {
        const body = JSON.parse(await readBody(req));
        this.bodies.push(body);
        this.headers.push(req.headers);
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
            steps: [
              {
                id: 'create-launch', kind: 'transaction', label: 'Create launch', depends_on: [],
                transaction: { chain_id: body.chain_id, from: body.creator, to: FACTORY, data: '0xabcdef12', value: FEE_RAW },
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

// ---------------------------------------------------------------------------------------------
describe('end to end (real process, local mock Telegram / o1 API / EVM node)', () => {
  const tg = new MockTelegram();
  const o1 = new MockO1();
  const rpc = new MockRpc(8453);
  const dataDir = tempDir();
  let child: ChildProcess;
  let output = '';

  beforeAll(async () => {
    await Promise.all([tg.start(), o1.start(), rpc.start()]);
    rpc.codeAddresses.add(TOKEN.toLowerCase());

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key];
    Object.assign(env, {
      NO_PROXY: '127.0.0.1,localhost',
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_API_ROOT: tg.url,
      ALLOWED_USER_IDS: String(OWNER),
      PRIVATE_KEY,
      O1_API_KEY: API_KEY,
      O1_API_BASE_URL: `${o1.url}/v1`,
      ENABLED_CHAINS: '8453',
      RPC_URL_8453: rpc.url,
      DATA_DIR: dataDir,
      LOG_LEVEL: 'debug',
      NODE_ENV: 'test',
    });
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: join(import.meta.dirname, '..'), env });
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));

    await vi.waitFor(() => {
      if (tg.polls === 0) throw new Error(`bot not polling yet\n${output}`);
    }, { timeout: 30_000, interval: 100 });
  }, 60_000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await Promise.all([tg.stop(), o1.stop(), rpc.stop()]);
  });

  const until = (predicate: () => boolean, what: string) =>
    vi.waitFor(() => {
      if (!predicate()) {
        const tail = tg.calls.slice(-12).map((c) => `${c.method} ${JSON.stringify({ id: c.payload.message_id, text: String(c.payload.text ?? '').slice(0, 40), alert: c.payload.show_alert })}`);
        throw new Error(`waiting for: ${what}\n--- panel ---\n${tg.panelText()}\n--- last bot API calls ---\n${tail.join('\n')}\n--- bot output ---\n${output.slice(-1500)}`);
      }
    }, { timeout: 20_000, interval: 50 });

  it('boots, verifies the chain and the API key', () => {
    expect(output).toContain('chain Base (8453) siap');
    expect(output).toContain('API o1 terhubung');
    expect(tg.calls.some((c) => c.method === 'setMyCommands')).toBe(true);
    expect(output).toContain(WALLET);
  });

  it('launches a Tax token from Telegram to a confirmed on-chain transaction', async () => {
    tg.command('launch');
    await until(() => tg.panelText().includes('Draft Launch o1'), 'dashboard');

    tg.press('in:name:dash');
    await until(() => tg.panelText().includes('nama token'), 'name prompt');
    tg.text('Pepe Coin');
    await until(() => tg.panelText().includes('Pepe Coin'), 'name set');

    tg.press('in:symbol:dash');
    await until(() => tg.panelText().includes('simbol'), 'symbol prompt');
    tg.text('$PEPE');
    await until(() => tg.panelText().includes('PEPE'), 'symbol set');

    tg.press('in:website:dash');
    await until(() => tg.panelText().includes('website'), 'website prompt');
    tg.text('pepe.example');
    await until(() => tg.panelText().includes('https://pepe.example'), 'website set');

    tg.press('in:image:dash');
    await until(() => tg.panelText().includes('gambar token'), 'image prompt');
    tg.photo('file-1');
    await until(() => tg.panelText().includes('Gambar: PNG'), 'image downloaded and accepted');

    tg.press('nav:tax');
    await until(() => tg.panelText().includes('Pengaturan Tax'), 'tax view');
    tg.press('pre:tax:5');
    await until(() => tg.panelText().includes('Buy 5% · Sell 5%'), 'tax preset');

    tg.press('nav:review');
    await until(() => tg.panelText().includes('Semua cek lolos'), 'review passes');
    expect(tg.panelText()).toContain('Creation fee: 0.001 ETH');

    tg.press('go:launch');
    await until(() => tg.panelText().includes('Launch berhasil'), 'launch success');

    // --- what the o1 API received (validated against the OpenAPI schema by the mock) ---
    expect(o1.bodies).toHaveLength(1);
    const body = o1.bodies[0]!;
    expect(body).toMatchObject({
      chain_id: 8453,
      creator: WALLET,
      market: 'standard',
      launch_product: 'tax',
      token: { name: 'Pepe Coin', symbol: 'PEPE', website: 'https://pepe.example', image_type: 'image/png' },
      tax: { format: 'inclusive', buy_tax_rate: '5000000', sell_tax_rate: '5000000', creator_fee_recipient: WALLET },
    });
    expect(Buffer.from(body.token.image_base64, 'base64')).toEqual(Buffer.from(PNG_BYTES));
    expect(o1.headers[0]?.['x-api-key']).toBe(API_KEY);
    expect(o1.headers[0]?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);

    // --- what the EVM node received: one signed transaction, exactly as the API planned it ---
    expect(rpc.received).toHaveLength(1);
    const sent = rpc.received[0]!;
    expect(sent.from).toBe(WALLET);
    expect(sent.tx.to?.toLowerCase()).toBe(FACTORY.toLowerCase());
    expect(sent.tx.data).toBe('0xabcdef12');
    expect(sent.tx.value).toBe(BigInt(FEE_RAW));
    expect(sent.tx.chainId).toBe(8453);

    // --- the user-facing result ---
    expect(tg.panelText()).toContain(TOKEN);
    expect(tg.panelText()).toContain(sent.hash.slice(0, 6));

    // --- durable record written before waiting for the receipt ---
    const lines = readFileSync(join(dataDir, 'launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.status)).toEqual(['sent', 'confirmed']);
    expect(lines[0]).toMatchObject({ txHash: sent.hash, token: TOKEN, symbol: 'PEPE', chainId: 8453 });
  }, 90_000);

  it('never writes a secret to the logs, even at debug level', () => {
    expect(output.length).toBeGreaterThan(100);
    expect(output).not.toContain(PRIVATE_KEY);
    expect(output).not.toContain(PRIVATE_KEY.slice(2));
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain('E2eSecretValue');
    expect(output).not.toContain(BOT_TOKEN);
  });
});

