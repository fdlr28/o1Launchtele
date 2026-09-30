import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FEE_RAW, tempDir } from './fakes.js';
import { FACTORY, TOKEN } from './fixtures.js';
import { API_KEY, BOT_TOKEN, MockO1, MockTelegram, OWNER, PRIVATE_KEY, WALLET } from './mock-servers.js';
import { MockRpc } from './mock-rpc.js';
import { PNG_BYTES } from './bot-harness.js';

/**
 * Runs the real process (src/index.ts) against three local servers that stand in for Telegram,
 * the o1 API and an EVM node. Nothing in the bot is faked: this exercises the real HTTP client,
 * long polling, viem signing/broadcasting and the wiring in index.ts.
 */

// ---------------------------------------------------------------------------------------------
describe('end to end (real process, local mock Telegram / o1 API / EVM node)', () => {
  const tg = new MockTelegram();
  const o1 = new MockO1();
  const rpc = new MockRpc(8453);
  const dataDir = tempDir();
  let child: ChildProcess;
  let output = '';

  /** Environment for a bot/doctor process pointed at the local mocks. */
  const childEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key];
    return Object.assign(env, {
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
    }, overrides);
  };

  /** Runs a script from src/ to completion and returns its exit code and combined output. */
  const runScript = (script: string, overrides: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', script], { cwd: join(import.meta.dirname, '..'), env: childEnv(overrides) });
      let out = '';
      proc.stdout?.on('data', (d) => (out += d));
      proc.stderr?.on('data', (d) => (out += d));
      proc.on('close', (code) => resolve({ code, out }));
    });

  beforeAll(async () => {
    await Promise.all([tg.start(), o1.start(), rpc.start()]);
    rpc.codeAddresses.add(TOKEN.toLowerCase());

    const env = childEnv();
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

  it('doctor: reports a healthy setup, exits 0 and prints no secret', async () => {
    const { code, out } = await runScript('src/doctorCli.ts');
    expect(out, out).toContain('✅ .env terbaca dan formatnya valid');
    expect(out).toContain('Telegram: token valid, bot @e2e_bot');
    expect(out).toContain(`Wallet launcher: ${WALLET}`);
    expect(out).toContain('Base (8453): RPC OK · saldo 1 ETH');
    expect(out).toContain('API o1: key valid');
    expect(out).toContain('Base · Tax: siap');
    expect(out).toContain('Siap. Jalankan bot dengan: npm start');
    expect(code).toBe(0);
    for (const secret of [PRIVATE_KEY, PRIVATE_KEY.slice(2), API_KEY, 'E2eSecretValue', BOT_TOKEN]) expect(out).not.toContain(secret);
  }, 60_000);

  it('doctor: exits 1 with a clear message for a wrong o1 API key or Telegram token', async () => {
    const badKey = await runScript('src/doctorCli.ts', { O1_API_KEY: 'o1_launch_deadbeef_WrongKeyValue-123' });
    expect(badKey.code).toBe(1);
    expect(badKey.out).toContain('API o1: key ditolak (invalid_api_key)');
    expect(badKey.out).not.toContain('WrongKeyValue');

    const wrongBot = '999999999:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    const badBot = await runScript('src/doctorCli.ts', { TELEGRAM_BOT_TOKEN: wrongBot });
    expect(badBot.code).toBe(1);
    expect(badBot.out).toContain('❌ Telegram:');
    expect(badBot.out).not.toContain(wrongBot);
  }, 90_000);

  it('doctor: an invalid .env lists every problem and prints no value', async () => {
    const { code, out } = await runScript('src/doctorCli.ts', { PRIVATE_KEY: 'not-a-key-secret', ALLOWED_USER_IDS: 'abc' });
    expect(code).toBe(1);
    expect(out).toContain('PRIVATE_KEY');
    expect(out).toContain('ALLOWED_USER_IDS');
    expect(out).not.toContain('not-a-key-secret');
  }, 60_000);

  it('never writes a secret to the logs, even at debug level', () => {
    expect(output.length).toBeGreaterThan(100);
    expect(output).not.toContain(PRIVATE_KEY);
    expect(output).not.toContain(PRIVATE_KEY.slice(2));
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain('E2eSecretValue');
    expect(output).not.toContain(BOT_TOKEN);
  });
});

