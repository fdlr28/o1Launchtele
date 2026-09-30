import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { createLogger, redact, secretVariants } from '../src/logger.js';

const KEY = `0x${'ab'.repeat(32)}`;
const BOT = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const API = 'o1_launch_abcdef12_SuperSecretValue-123_abc';

const valid: NodeJS.ProcessEnv = {
  TELEGRAM_BOT_TOKEN: BOT,
  ALLOWED_USER_IDS: '111, 222',
  PRIVATE_KEY: KEY,
  O1_API_KEY: API,
};

function errorOf(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('loads a minimal valid environment with sensible defaults', () => {
    const cfg = loadConfig(valid);
    expect([...cfg.allowedUserIds]).toEqual([111, 222]);
    expect(cfg.privateKey).toBe(KEY);
    expect(cfg.o1ApiBaseUrl).toBe('https://api.launch.o1.exchange/v1');
    expect(cfg.devBuySlippageBps).toBe(500);
    expect(cfg.strictTargets).toBe(true);
    expect(cfg.dataDir).toBe('./data');
    // chains with a well-known public RPC are enabled by default; Robinhood and Arc need an explicit RPC
    expect(cfg.chainIds.sort((a, b) => a - b)).toEqual([56, 143, 196, 8453]);
    expect(cfg.rpcUrls[4663]).toBeUndefined();
    expect(cfg.rpcUrls[5042]).toBeUndefined();
  });

  it('accepts a private key without 0x prefix', () => {
    expect(loadConfig({ ...valid, PRIVATE_KEY: 'ab'.repeat(32) }).privateKey).toBe(KEY);
  });

  it('enables Robinhood/Arc once an RPC is provided, and honours overrides', () => {
    const cfg = loadConfig({ ...valid, RPC_URL_4663: 'https://rpc.rh.example', RPC_URL_8453: 'https://my.base.rpc', EXPLORER_URL_143: 'https://scan.monad.example' });
    expect(cfg.chainIds).toContain(4663);
    expect(cfg.rpcUrls[8453]).toBe('https://my.base.rpc');
    expect(cfg.explorerUrls[143]).toBe('https://scan.monad.example');
  });

  it('restricts chains with ENABLED_CHAINS', () => {
    expect(loadConfig({ ...valid, ENABLED_CHAINS: '8453, 56' }).chainIds).toEqual([8453, 56]);
    expect(errorOf({ ...valid, ENABLED_CHAINS: '8453,999' })).toContain('tidak didukung');
    expect(errorOf({ ...valid, ENABLED_CHAINS: '5042' })).toContain('RPC_URL_5042');
  });

  it('reports every problem at once', () => {
    const message = errorOf({});
    for (const name of ['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_IDS', 'PRIVATE_KEY', 'O1_API_KEY']) expect(message).toContain(name);
  });

  it('validates formats', () => {
    expect(errorOf({ ...valid, TELEGRAM_BOT_TOKEN: 'nope' })).toContain('TELEGRAM_BOT_TOKEN');
    expect(errorOf({ ...valid, ALLOWED_USER_IDS: 'abc' })).toContain('bukan ID numerik');
    expect(errorOf({ ...valid, ALLOWED_USER_IDS: '' })).toContain('ALLOWED_USER_IDS');
    expect(errorOf({ ...valid, PRIVATE_KEY: '0x123' })).toContain('PRIVATE_KEY');
    expect(errorOf({ ...valid, O1_API_KEY: 'sk-123' })).toContain('O1_API_KEY');
    expect(errorOf({ ...valid, O1_API_BASE_URL: 'ftp://x' })).toContain('O1_API_BASE_URL');
    expect(errorOf({ ...valid, RPC_URL_8453: 'not a url' })).toContain('RPC_URL_8453');
    expect(errorOf({ ...valid, DEV_BUY_SLIPPAGE_BPS: '5000' })).toContain('DEV_BUY_SLIPPAGE_BPS');
    expect(errorOf({ ...valid, DEV_BUY_SLIPPAGE_BPS: '0' })).toContain('DEV_BUY_SLIPPAGE_BPS');
    expect(errorOf({ ...valid, STRICT_TARGETS: 'maybe' })).toContain('STRICT_TARGETS');
    expect(errorOf({ ...valid, LOG_LEVEL: 'loud' })).toContain('LOG_LEVEL');
  });

  it('never echoes secrets in error messages', () => {
    const message = errorOf({ ...valid, PRIVATE_KEY: 'deadbeef-secret-ish', O1_API_KEY: 'sk-secret-value' });
    expect(message).not.toContain('deadbeef-secret-ish');
    expect(message).not.toContain('sk-secret-value');
  });

  it('parses slippage and strict flag', () => {
    const cfg = loadConfig({ ...valid, DEV_BUY_SLIPPAGE_BPS: '750', STRICT_TARGETS: 'false', LOG_LEVEL: 'debug' });
    expect(cfg.devBuySlippageBps).toBe(750);
    expect(cfg.strictTargets).toBe(false);
    expect(cfg.logLevel).toBe('debug');
  });
});

describe('logger redaction', () => {
  const secrets = secretVariants(KEY);

  it('redacts the bot token (also inside Telegram file URLs), the o1 API key and the private key', () => {
    const text = `token=${BOT} key=${API} pk=${KEY} raw=${KEY.slice(2)} url=https://api.telegram.org/file/bot${BOT}/photos/a.jpg`;
    const out = redact(text, secrets);
    expect(out).not.toContain(BOT);
    expect(out).not.toContain('SuperSecretValue');
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(KEY.slice(2));
    expect(out).toContain('o1_launch_***');
    expect(out).toContain('/file/bot<telegram-bot-token>/photos/a.jpg');
  });

  it('keeps transaction hashes and addresses readable (only the real secret is removed)', () => {
    const txHash = `0x${'cd'.repeat(32)}`;
    const address = '0x1111111111111111111111111111111111111111';
    expect(redact(`tx ${txHash} to ${address}`, secrets)).toBe(`tx ${txHash} to ${address}`);
  });

  it('applies redaction to everything the logger prints, including errors and objects', () => {
    const lines: string[] = [];
    const log = createLogger('debug', (line) => lines.push(line), secrets);
    log.info(`using ${API}`);
    log.error('boom', new Error(`failed with key ${KEY}`));
    log.warn('obj', { pk: KEY, url: `https://api.telegram.org/file/bot${BOT}/x` });
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toContain(KEY);
      expect(line).not.toContain(KEY.slice(2));
      expect(line).not.toContain('SuperSecretValue');
      expect(line).not.toContain(BOT);
    }
  });

  it('respects the log level', () => {
    const lines: string[] = [];
    const log = createLogger('warn', (line) => lines.push(line));
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines.map((l) => l.split(' ')[1])).toEqual(['WARN', 'ERROR']);
  });
});
