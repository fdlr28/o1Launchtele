import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FEE_RAW, tempDir } from './fakes.js';
import { FACTORY, TOKEN, USDC } from './fixtures.js';
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
    const lines = readFileSync(join(dataDir, 'launches.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
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


// ---------------------------------------------------------------------------------------------
/** A complete stack of mocks plus the real bot process, for tests that need their own lifecycle. */
interface Stack {
  tg: MockTelegram;
  o1: MockO1;
  rpc: MockRpc;
  dataDir: string;
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
  until: (predicate: () => boolean, what: string, timeout?: number) => Promise<void>;
  fillAndReview: () => Promise<void>;
  stop: () => Promise<void>;
}

async function boot(
  opts: {
    seedHistory?: string;
    prepareDelayMs?: number;
    env?: Record<string, string>;
    /** Runs against the mock node before the bot starts. */
    prepare?: (rpc: MockRpc) => void;
    /** Runs against the mock o1 API before the bot starts. */
    configureO1?: (o1: MockO1) => void;
    /** False when the process is expected to leave before it ever polls Telegram. */
    waitForPolling?: boolean;
  } = {},
): Promise<Stack> {
  const tg = new MockTelegram();
  const o1 = new MockO1();
  const rpc = new MockRpc(8453);
  await Promise.all([tg.start(), o1.start(), rpc.start()]);
  rpc.codeAddresses.add(TOKEN.toLowerCase());
  o1.prepareDelayMs = opts.prepareDelayMs ?? 0;
  opts.prepare?.(rpc);
  opts.configureO1?.(o1);
  const dataDir = tempDir();
  if (opts.seedHistory) writeFileSync(join(dataDir, 'launches.jsonl'), opts.seedHistory);

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
    ...opts.env,
  });
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: join(import.meta.dirname, '..'), env });
  let out = '';
  child.stdout?.on('data', (d) => (out += d));
  child.stderr?.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

  const until = (predicate: () => boolean, what: string, timeout = 20_000) =>
    vi.waitFor(() => {
      if (!predicate()) throw new Error(`waiting for: ${what}\n--- panel ---\n${tg.panelText()}\n--- bot output ---\n${out.slice(-1500)}`);
    }, { timeout, interval: 50 });

  if (opts.waitForPolling !== false) {
    await vi.waitFor(() => {
      if (tg.polls === 0) throw new Error(`bot not polling yet\n${out}`);
    }, { timeout: 30_000, interval: 100 });
  }

  const fillAndReview = async () => {
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
    tg.press('in:image:dash');
    await until(() => tg.panelText().includes('gambar token'), 'image prompt');
    tg.photo('file-1');
    await until(() => tg.panelText().includes('Gambar: PNG'), 'image accepted');
    tg.press('nav:review');
    await until(() => tg.panelText().includes('Review Launch'), 'review shown');
  };

  return {
    tg, o1, rpc, dataDir, child, exited, until, fillAndReview,
    output: () => out,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited;
      await Promise.all([tg.stop(), o1.stop(), rpc.stop()]);
    },
  };
}

describe('end to end: shutdown and crash recovery (real process)', () => {
  let stack: Stack | undefined;
  afterEach(async () => {
    await stack?.stop();
    stack = undefined;
  });

  it('exits promptly and cleanly on SIGTERM when nothing is running', async () => {
    stack = await boot();
    stack.child.kill('SIGTERM');
    const code = await Promise.race([stack.exited, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 15_000))]);
    expect(code).toBe(0);
    expect(stack.output()).toContain('SIGTERM: berhenti menerima perintah baru');
  }, 60_000);

  it('lets a running launch finish, delivers its result, and only then exits', async () => {
    stack = await boot({ prepareDelayMs: 3_000 });
    const { tg, o1, rpc, until, child, exited } = stack;
    await stack.fillAndReview();
    tg.press('go:launch');
    await until(() => o1.bodies.length === 1, 'prepare request in flight');

    child.kill('SIGTERM');
    const early = await Promise.race([exited, new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 1_000))]);
    expect(early, 'the bot must not exit while a launch is running').toBe('alive');

    const code = await Promise.race([exited, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 40_000))]);
    expect(code).toBe(0);
    expect(stack.output()).toContain('menunggu sampai selesai');

    // the launch was completed on chain ...
    expect(rpc.received).toHaveLength(1);
    const lines = readFileSync(join(stack.dataDir, 'launches.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.status)).toEqual(['sent', 'confirmed']);
    // ... and the user was told, even though the process was already shutting down
    expect(tg.panelText()).toContain('Launch berhasil');
  }, 90_000);

  it('a launch left unresolved by a crash blocks new launches and warns the owner at startup', async () => {
    const hash = `0x${'a1'.repeat(32)}`;
    stack = await boot({
      seedHistory: JSON.stringify({ ts: new Date().toISOString(), kind: 'launch', status: 'unknown', chainId: 8453, name: 'Old Coin', symbol: 'OLD', txHash: hash }) + '\n',
    });
    const { tg, rpc, until } = stack;

    await until(() => tg.calls.some((c) => c.method === 'sendMessage' && String(c.payload.text).includes('Bot baru saja menyala')), 'startup warning');
    const warning = String(tg.calls.find((c) => String(c.payload.text ?? '').includes('Bot baru saja menyala'))?.payload.text);
    expect(warning).toContain('Old Coin');
    expect(warning).toContain(`https://basescan.org/tx/${hash}`);
    expect(warning).toContain('/dismiss ya');
    expect(stack.output()).toContain(`launch tertunda: ${hash}`);

    await stack.fillAndReview();
    expect(tg.panelText()).toContain('Ada launch sebelumnya yang hasilnya belum jelas');
    expect(tg.calls.some((c) => c.payload.reply_markup && JSON.stringify(c.payload.reply_markup).includes('go:launch'))).toBe(false);
    tg.press('go:launch'); // even a forged button press cannot get around it
    await until(() => tg.calls.some((c) => c.method === 'answerCallbackQuery' && String(c.payload.text).includes('Review')), 'launch refused');
    expect(rpc.received).toHaveLength(0);

    tg.command('dismiss');
    await until(() => tg.calls.some((c) => c.method === 'sendMessage' && String(c.payload.text).includes('Launch tertunda')), '/dismiss lists it');
    tg.text('/dismiss ya', [{ type: 'bot_command', offset: 0, length: 8 }]);
    await until(() => tg.calls.some((c) => c.method === 'sendMessage' && String(c.payload.text).includes('Diabaikan: 1')), 'dismissed');

    tg.press('nav:review');
    await until(() => tg.panelText().includes('Semua cek lolos'), 'review passes again');
  }, 90_000);

  it('a Telegram 409 (another instance polls the same token) does not cut a running launch: it finishes, then the bot leaves with an error code', async () => {
    stack = await boot();
    const { tg, o1, rpc, until, exited } = stack;
    rpc.autoMine = false; // the launch is pending until we mine it
    await stack.fillAndReview();
    tg.press('go:launch');
    await until(() => rpc.received.length === 1, 'launch broadcast');

    tg.getUpdatesFault = { code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' };
    const early = await Promise.race([exited, new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 2_500))]);
    expect(early, 'the bot must wait for the pending launch instead of exiting on the 409').toBe('alive');
    expect(stack.output()).toContain('error Telegram: berhenti menerima perintah baru');

    rpc.mine(); // the launch confirms
    const code = await Promise.race([exited, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 30_000))]);
    expect(code).toBe(1); // still an error exit, so systemd restarts it
    expect(o1.bodies).toHaveLength(1);
    const lines = readFileSync(join(stack.dataDir, 'launches.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.status)).toEqual(['sent', 'confirmed']);
    expect(tg.panelText()).toContain('Launch berhasil');
  }, 90_000);

  it('an unclear launch that confirms later is announced by the watcher, and closes its draft (the recovery path, end to end)', async () => {
    const hash = `0x${'c1'.repeat(32)}`;
    stack = await boot({
      env: { O1_BOT_WATCH_INTERVAL_MS: '300' },
      seedHistory:
        JSON.stringify({ ts: new Date().toISOString(), kind: 'launch', status: 'unknown', chainId: 8453, name: 'Late Coin', symbol: 'LATE', token: TOKEN, txHash: hash, draftId: 'late-draft' }) + '\n',
    });
    const { tg, rpc, until } = stack;
    await until(() => tg.calls.some((c) => String(c.payload.text ?? '').includes('Bot baru saja menyala')), 'startup warning (still unresolved)');

    rpc.addMinedTransaction(hash as never); // the chain finally shows it
    await until(() => tg.calls.some((c) => String(c.payload.text ?? '').includes('ternyata BERHASIL')), 'the watcher announces the late confirmation', 15_000);
    const notice = String(tg.calls.find((c) => String(c.payload.text ?? '').includes('ternyata BERHASIL'))?.payload.text);
    expect(notice).toContain('Late Coin ($LATE)');
    expect(notice).toContain(`Token: ${TOKEN}`);
    expect(notice).toContain(`https://basescan.org/tx/${hash}`);
    expect(notice).toContain('tidak bisa diluncurkan lagi');
    // announced once, however many ticks follow
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(tg.calls.filter((c) => String(c.payload.text ?? '').includes('ternyata BERHASIL'))).toHaveLength(1);
    const lines = readFileSync(join(stack.dataDir, 'launches.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.status)).toEqual(['unknown', 'confirmed']);
  }, 60_000);

  it('a launch that confirmed while the bot was down is announced as soon as the bot is up (not lost before Telegram exists)', async () => {
    const hash = `0x${'c2'.repeat(32)}`;
    stack = await boot({
      prepare: (rpc) => rpc.addMinedTransaction(hash as never),
      seedHistory: JSON.stringify({ ts: new Date().toISOString(), kind: 'launch', status: 'sent', chainId: 8453, name: 'Down Coin', symbol: 'DOWN', token: TOKEN, txHash: hash }) + '\n',
    });
    await stack.until(() => stack!.tg.calls.some((c) => String(c.payload.text ?? '').includes('ternyata BERHASIL')), 'early notice delivered');
    expect(String(stack.tg.calls.find((c) => String(c.payload.text ?? '').includes('ternyata BERHASIL'))?.payload.text)).toContain('Down Coin');
    expect(stack.tg.calls.some((c) => String(c.payload.text ?? '').includes('Bot baru saja menyala'))).toBe(false); // nothing is unresolved any more
  }, 60_000);

  describe('the owner\'s ceilings reach the running bot (round-3 review: wiring)', () => {
    const ONE_ETH = (10n ** 18n).toString();

    it('a creation fee above the built-in ceiling is refused in Review, and launches once MAX_CREATION_FEE_8453 allows it', async () => {
      stack = await boot({ configureO1: (o1) => (o1.feeRaw = ONE_ETH), prepare: (rpc) => (rpc.balance = 10n * 10n ** 18n) });
      await stack.fillAndReview();
      expect(stack.tg.panelText()).toContain('melebihi batas keamanan bot');
      expect(stack.tg.panelText()).toContain('MAX_CREATION_FEE_8453');
      expect(stack.rpc.received).toHaveLength(0);
      await stack.stop();
      stack = undefined;

      stack = await boot({ env: { MAX_CREATION_FEE_8453: '2' }, configureO1: (o1) => (o1.feeRaw = ONE_ETH), prepare: (rpc) => (rpc.balance = 10n * 10n ** 18n) });
      const { tg, rpc, until } = stack;
      await stack.fillAndReview();
      await until(() => tg.panelText().includes('Semua cek lolos'), 'review passes with the raised ceiling');
      tg.press('go:launch');
      await until(() => tg.panelText().includes('Launch berhasil'), 'launch with the raised ceiling');
      expect(rpc.received[0]?.tx.value).toBe(10n ** 18n);
    }, 120_000);
  });

  describe('ALLOWED_FEE_TOKENS reaches the running bot (round-4 review: wiring)', () => {
    const FEE_TOKEN = USDC;
    const tokenFee = (o1: MockO1) => {
      o1.feeToken = { address: FEE_TOKEN, symbol: 'USDC', decimals: 6 };
      o1.feeRaw = '1000000';
    };
    const knowsToken = (rpc: MockRpc) => rpc.tokens.set(FEE_TOKEN.toLowerCase(), 6);

    it('a creation fee in a token is refused in Review, naming the setting; with the token listed the refusal is gone', async () => {
      stack = await boot({ configureO1: tokenFee, prepare: knowsToken });
      await stack.fillAndReview();
      expect(stack.tg.panelText()).toContain(`ALLOWED_FEE_TOKENS=${FEE_TOKEN}`);
      await stack.stop();
      stack = undefined;

      stack = await boot({ env: { ALLOWED_FEE_TOKENS: FEE_TOKEN }, configureO1: tokenFee, prepare: knowsToken });
      await stack.fillAndReview();
      expect(stack.tg.panelText()).not.toContain('ALLOWED_FEE_TOKENS');
      expect(stack.tg.panelText()).not.toContain('meminta creation fee dalam token');
      expect(stack.rpc.received).toHaveLength(0); // Review never sends anything
    }, 120_000);

    it('a listed fee token goes through the launcher itself: approve exactly the fee, then launch (the launcher gets the list too)', async () => {
      stack = await boot({
        env: { ALLOWED_FEE_TOKENS: FEE_TOKEN },
        configureO1: tokenFee,
        prepare: (rpc) => {
          knowsToken(rpc);
          rpc.erc20Balance = 10_000_000n;
        },
      });
      const { tg, rpc, until } = stack;
      await stack.fillAndReview();
      await until(() => tg.panelText().includes('Semua cek lolos'), 'review passes with the listed fee token');
      tg.press('go:launch');
      await until(() => tg.panelText().includes('Launch berhasil'), 'launch with a fee paid in a listed token');
      expect(rpc.received).toHaveLength(2);
      expect(String(rpc.received[0]?.tx.to).toLowerCase()).toBe(FEE_TOKEN.toLowerCase()); // the approval of the fee ...
      expect(String(rpc.received[1]?.tx.to).toLowerCase()).toBe(FACTORY.toLowerCase()); // ... then the launch
      expect(rpc.received[1]?.tx.value ?? 0n).toBe(0n); // nothing native goes along: the fee was paid in the token
    }, 120_000);
  });

  it('refuses to start, saying why, when the launch log cannot be written', async () => {
    const notADirectory = join(tempDir(), 'data');
    writeFileSync(notADirectory, 'a file where the data folder should be');
    stack = await boot({ env: { DATA_DIR: notADirectory }, waitForPolling: false });
    const code = await Promise.race([stack.exited, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 20_000))]);
    expect(code).toBe(1);
    expect(stack.output()).toContain('tidak bisa ditulis');
    expect(stack.output()).toContain('bot tidak akan mengirim transaksi apa pun');
    expect(stack.tg.polls).toBe(0);
  }, 60_000);

  it('refuses to start with a plain-http o1 API URL, naming the problem and leaking nothing', async () => {
    const tg = new MockTelegram();
    await tg.start();
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key];
      Object.assign(env, {
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_API_ROOT: tg.url,
        ALLOWED_USER_IDS: String(OWNER),
        PRIVATE_KEY,
        O1_API_KEY: API_KEY,
        O1_API_BASE_URL: 'http://api.example.com/v1',
        ENABLED_CHAINS: '8453',
        RPC_URL_8453: 'https://rpc.example.com',
        DATA_DIR: tempDir(),
      });
      const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: join(import.meta.dirname, '..'), env });
        let out = '';
        proc.stdout?.on('data', (d) => (out += d));
        proc.stderr?.on('data', (d) => (out += d));
        proc.on('close', (code) => resolve({ code, out }));
      });
      expect(result.code).toBe(1);
      expect(result.out).toContain('O1_API_BASE_URL harus URL https://');
      expect(result.out).not.toContain(API_KEY);
      expect(tg.polls).toBe(0);
    } finally {
      await tg.stop();
    }
  }, 60_000);
});
