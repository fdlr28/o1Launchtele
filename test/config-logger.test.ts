import { describe, expect, it } from 'vitest';
import { ConfigError, configSecrets, loadConfig } from '../src/config.js';
import { describeError, setErrorSanitizer } from '../src/errors.js';
import { createLogger, redact, secretVariants, urlSecrets } from '../src/logger.js';

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
    expect(cfg.extraAllowedTargets).toEqual([]);
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
    expect(errorOf({ ...valid, LOG_LEVEL: 'loud' })).toContain('LOG_LEVEL');
  });

  it('never echoes secrets in error messages', () => {
    const message = errorOf({ ...valid, PRIVATE_KEY: 'deadbeef-secret-ish', O1_API_KEY: 'sk-secret-value' });
    expect(message).not.toContain('deadbeef-secret-ish');
    expect(message).not.toContain('sk-secret-value');
  });

  it('parses slippage and log level', () => {
    const cfg = loadConfig({ ...valid, DEV_BUY_SLIPPAGE_BPS: '750', LOG_LEVEL: 'debug' });
    expect(cfg.devBuySlippageBps).toBe(750);
    expect(cfg.logLevel).toBe('debug');
  });

  it('the target check cannot be switched off any more', () => {
    for (const value of ['false', 'no', '0', 'maybe']) {
      const message = errorOf({ ...valid, STRICT_TARGETS: value });
      expect(message, value).toContain('STRICT_TARGETS sudah dihapus');
      expect(message).toContain('EXTRA_ALLOWED_TARGETS');
    }
    // a leftover STRICT_TARGETS=true only states what the bot does anyway
    expect(() => loadConfig({ ...valid, STRICT_TARGETS: 'true' })).not.toThrow();
    expect(() => loadConfig({ ...valid, STRICT_TARGETS: 'TRUE' })).not.toThrow();
  });

  it('never echoes a long value in an error: a secret may have been pasted into the wrong variable', () => {
    const pasted = `0x${'ab'.repeat(32)}`;
    for (const name of ['ALLOWED_USER_IDS', 'EXTRA_ALLOWED_TARGETS', 'ENABLED_CHAINS']) {
      const message = errorOf({ ...valid, [name]: pasted, ...(name === 'ENABLED_CHAINS' ? {} : {}) });
      expect(message, name).not.toContain(pasted);
      expect(message, name).toContain('karakter)');
    }
    expect(errorOf({ ...valid, ALLOWED_USER_IDS: 'abc' })).toContain('"abc"'); // short values stay readable
  });

  it('reads EXTRA_ALLOWED_TARGETS as a list of addresses and rejects anything else', () => {
    const a = '0x1111111111111111111111111111111111111111';
    const b = '0xAbCdEf0123456789aBcDeF0123456789aBcDeF01';
    expect(loadConfig({ ...valid, EXTRA_ALLOWED_TARGETS: ` ${a}, ${b}` }).extraAllowedTargets).toEqual([a, b.toLowerCase()]);
    expect(errorOf({ ...valid, EXTRA_ALLOWED_TARGETS: `${a},0x12` })).toContain('EXTRA_ALLOWED_TARGETS berisi alamat yang tidak valid: "0x12"');
  });
});

describe('secure URLs', () => {
  it('requires https for everything that carries a key or a token, except on this machine', () => {
    expect(errorOf({ ...valid, O1_API_BASE_URL: 'http://api.example.com/v1' })).toContain('O1_API_BASE_URL harus URL https://');
    expect(errorOf({ ...valid, TELEGRAM_API_ROOT: 'http://bot-api.example.com' })).toContain('TELEGRAM_API_ROOT harus URL https://');
    expect(errorOf({ ...valid, RPC_URL_8453: 'http://rpc.example.com' })).toContain('RPC_URL_8453 harus URL https://');
    expect(errorOf({ ...valid, EXPLORER_URL_8453: 'http://scan.example.com' })).toContain('EXPLORER_URL_8453 harus URL https://');
    // ... a userinfo trick must not pass for localhost
    expect(errorOf({ ...valid, O1_API_BASE_URL: 'http://localhost:80@evil.example.com/v1' })).toContain('O1_API_BASE_URL');
    expect(errorOf({ ...valid, RPC_URL_8453: 'http://127.0.0.1.evil.example.com' })).toContain('RPC_URL_8453');

    const local = loadConfig({
      ...valid,
      O1_API_BASE_URL: 'http://127.0.0.1:9000/v1',
      TELEGRAM_API_ROOT: 'http://localhost:8081',
      RPC_URL_8453: 'http://[::1]:8545',
    });
    expect(local.o1ApiBaseUrl).toBe('http://127.0.0.1:9000/v1');
    expect(local.rpcUrls[8453]).toBe('http://[::1]:8545');
    expect(loadConfig({ ...valid, O1_API_BASE_URL: 'https://api.example.com/v1' }).o1ApiBaseUrl).toBe('https://api.example.com/v1');
  });
});

describe('credential-bearing URLs', () => {
  const RPC = 'https://base-mainnet.g.alchemy.com/v2/AbCdEf0123456789KeyKeyKey';

  it('extracts the key of an RPC URL, but leaves public endpoints readable', () => {
    const parts = urlSecrets(RPC);
    expect(parts).toContain(RPC);
    expect(parts).toContain('AbCdEf0123456789KeyKeyKey');
    expect(urlSecrets('https://mainnet.base.org')).toEqual([]);
    expect(urlSecrets('https://rpc.example/v1?apikey=abcdefgh1234&x=1')).toContain('abcdefgh1234');
    expect(urlSecrets('https://user:hunter2hunter2@rpc.example')).toEqual(expect.arrayContaining(['hunter2hunter2']));
    expect(urlSecrets('not a url')).toEqual([]);
  });

  it('keeps the RPC key out of logs and error descriptions, whichever way it shows up', () => {
    const config = loadConfig({ ...valid, RPC_URL_8453: RPC });
    const secrets = configSecrets(config);
    const lines: string[] = [];
    const log = createLogger('debug', (line) => lines.push(line), secrets);
    log.error('rpc failed', new Error(`HTTP request failed. URL: ${RPC} Details: boom`));
    log.warn(`falling back from .../v2/AbCdEf0123456789KeyKeyKey`);
    for (const line of lines) expect(line).not.toContain('AbCdEf0123456789KeyKeyKey');
    expect(lines[0]).toContain('HTTP request failed');

    setErrorSanitizer((text) => redact(text, secrets));
    try {
      const shown = describeError(new Error(`connect to ${RPC} failed`));
      expect(shown).not.toContain('AbCdEf0123456789KeyKeyKey');
      expect(shown).toContain('connect to');
    } finally {
      setErrorSanitizer((text) => text);
    }
  });

  it('redacts credentials in ANY url, not only in the ones the config knows (round-2 review)', () => {
    expect(redact('GET https://user:hunter2@rpc.example/x failed')).toBe('GET https://<redacted>@rpc.example/x failed');
    expect(redact('https://rpc.example/v1?key=ab12&x=1')).toBe('https://rpc.example/v1?key=<redacted>&x=1');
    expect(redact('https://rpc.example/?apikey=abc&Token=t0k3n&chain=8453')).toBe('https://rpc.example/?apikey=<redacted>&Token=<redacted>&chain=8453');
    expect(redact('https://mainnet.base.org/ is fine')).toBe('https://mainnet.base.org/ is fine');
  });

  it('a short key inside a longer path or query of a configured RPC URL is caught as a whole', () => {
    const short = 'https://rpc.example/v2/abc12345?tag=zz&auth=k9';
    const parts = urlSecrets(short);
    expect(parts).toEqual(expect.arrayContaining(['/v2/abc12345', '?tag=zz&auth=k9', 'abc12345']));
    const out = redact(`error calling ${short} (path /v2/abc12345)`, parts);
    expect(out).not.toContain('abc12345');
    expect(out).not.toContain('k9');
  });

  it('collects every secret of a config: key with and without 0x, o1 key, bot token and RPC keys', () => {
    const secrets = configSecrets(loadConfig({ ...valid, RPC_URL_8453: RPC }));
    for (const expected of [KEY, KEY.slice(2), API, BOT, 'AbCdEf0123456789KeyKeyKey']) expect(secrets).toContain(expected);
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
