import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { runDoctor, type DoctorDeps } from '../src/doctor.js';
import { ApiError } from '../src/o1/client.js';
import type { ChainCheck } from '../src/wallet/wallet.js';
import { WALLET, configFor } from './fixtures.js';

function makeDeps(overrides: Partial<DoctorDeps> = {}) {
  const ping = vi.fn(async () => {});
  const tokenIndexed = vi.fn(async () => false);
  const getConfig = vi.fn(async (_chain: number, opts: { product: 'tax' | 'non-tax' }) => configFor(opts.product));
  const deps: DoctorDeps = {
    config: { allowedUserIds: new Set([1, 2]), dataDir: '/srv/o1bot/data', extraAllowedTargets: [], maxCreationFeeWei: {}, allowedFeeTokens: [] },
    history: { assertWritable: async () => {}, pending: async () => [] },
    telegramGetMe: async () => ({ username: 'my_bot' }),
    wallet: {
      address: WALLET,
      verifyChains: async (): Promise<ChainCheck[]> => [{ chainId: 8453, ok: true }],
      nativeBalance: async () => 10n ** 16n,
    },
    api: { ping, tokenIndexed, getConfig } as unknown as DoctorDeps['api'],
    ...overrides,
  };
  return { deps, ping, tokenIndexed, getConfig };
}

const text = (lines: string[]) => lines.join('\n');
const apiError = (status: number, code: string) => new ApiError(status, code, code, { status, code });

describe('runDoctor', () => {
  it('reports a fully working setup', async () => {
    const { deps } = makeDeps();
    const report = await runDoctor(deps);
    expect(report.ok).toBe(true);
    const out = text(report.lines);
    expect(out).toContain('✅ Telegram: token valid, bot @my_bot');
    expect(out).toContain('2 user Telegram diizinkan');
    expect(out).toContain(`Wallet launcher: ${WALLET}`);
    expect(out).toContain('Base (8453): RPC OK · saldo 0.01 ETH');
    expect(out).toContain('API o1: key valid (scope config:read OK)');
    expect(out).toContain('scope tokens:read OK');
    expect(out).toContain('Base · Tax: siap — 3 pair, creation fee 0.001 ETH');
    expect(out).toContain('Base · Standard: siap');
    expect(out).toContain('Siap. Jalankan bot dengan: npm start');
    expect(out).toContain('launches:prepare, swaps:quote, swaps:prepare tidak bisa dicek');
  });

  it('checks that the launch log can be written and read, and mentions unresolved launches', async () => {
    const ok = await runDoctor(makeDeps().deps);
    expect(text(ok.lines)).toContain('✅ Folder data bisa ditulis (/srv/o1bot/data)');

    const readonly = await runDoctor(makeDeps({ history: { assertWritable: async () => { throw new Error('EACCES: permission denied'); }, pending: async () => [] } }).deps);
    expect(readonly.ok).toBe(false);
    expect(text(readonly.lines)).toContain('❌ Folder data (/srv/o1bot/data) tidak bisa ditulis: Terjadi kesalahan: EACCES');

    const unreadable = await runDoctor(makeDeps({ history: { assertWritable: async () => {}, pending: async () => { throw new Error('EISDIR'); } } }).deps);
    expect(unreadable.ok).toBe(false);
    expect(text(unreadable.lines)).toContain('❌ Riwayat launch tidak bisa dibaca');

    const pending = await runDoctor(makeDeps({ history: { assertWritable: async () => {}, pending: async () => [{ chainId: 8453, name: 'Old Coin', txHash: '0xabc' }] } }).deps);
    expect(pending.ok).toBe(true); // a warning, not a blocker for starting the bot
    expect(text(pending.lines)).toContain('⚠️ Ada 1 launch yang hasilnya belum jelas (Old Coin 0xabc)');
  });

  it('warns when a chain uses a Permit2 that is not the canonical one, unless the owner vouched for it', async () => {
    const odd = '0x00000000000000000000000000000000000abcde';
    const oddConfig = (product: 'tax' | 'non-tax') => {
      const cfg = configFor(product);
      cfg.suites![0]!.contracts.permit2 = odd;
      return cfg;
    };
    const getConfig = vi.fn(async (_chain: number, opts: { product: 'tax' | 'non-tax' }) => oddConfig(opts.product));
    const warned = await runDoctor(makeDeps({ api: { ping: async () => {}, tokenIndexed: async () => false, getConfig } as unknown as DoctorDeps['api'] }).deps);
    expect(text(warned.lines)).toContain('Permit2 chain ini (0x00000000000000000000000000000000000abcde) bukan Permit2 kanonis');
    expect(warned.ok).toBe(true); // a warning: native dev buys and launches are unaffected

    const vouched = await runDoctor(
      makeDeps({
        api: { ping: async () => {}, tokenIndexed: async () => false, getConfig } as unknown as DoctorDeps['api'],
        config: { allowedUserIds: new Set([1]), dataDir: '/d', extraAllowedTargets: [odd], maxCreationFeeWei: {}, allowedFeeTokens: [] },
      }).deps,
    );
    expect(text(vouched.lines)).not.toContain('bukan Permit2 kanonis');
    // the canonical one (the fixture's default) is silent
    expect(text((await runDoctor(makeDeps().deps)).lines)).not.toContain('Permit2');
  });

  it('warns when a native creation fee is above the bot\'s ceiling, and shows it with the chain\'s own decimals', async () => {
    const pricey = () => {
      const cfg = configFor('tax');
      cfg.suites![0]!.creation_fee = { amount_raw: (10n ** 18n).toString(), currency: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 24 };
      return cfg;
    };
    const getConfig = vi.fn(async () => pricey());
    const report = await runDoctor(makeDeps({ api: { ping: async () => {}, tokenIndexed: async () => false, getConfig } as unknown as DoctorDeps['api'] }).deps);
    const out = text(report.lines);
    expect(out).toContain('creation fee 1 ETH'); // not "0.000001" because the API claimed 24 decimals
    expect(out).toContain('creation fee melebihi batas keamanan bot');
    expect(out).toContain('MAX_CREATION_FEE_8453');
  });

  it('warns about an ERC-20 creation fee that the owner has not allowed, and about native decimals that differ from the chain', async () => {
    const tokenFee = () => {
      const cfg = configFor('tax');
      cfg.suites![0]!.creation_fee = { amount_raw: '5000000', currency: '0x0000000000000000000000000000000000005555', symbol: 'USDC', decimals: 6 };
      return cfg;
    };
    const apiWith = (cfg: () => ReturnType<typeof configFor>) =>
      ({ ping: async () => {}, tokenIndexed: async () => false, getConfig: vi.fn(async () => cfg()) }) as unknown as DoctorDeps['api'];
    const refused = await runDoctor(makeDeps({ api: apiWith(tokenFee) }).deps);
    expect(text(refused.lines)).toContain('o1 meminta creation fee dalam token 0x0000000000000000000000000000000000005555');
    expect(text(refused.lines)).toContain('ALLOWED_FEE_TOKENS');
    const allowed = await runDoctor(
      makeDeps({
        api: apiWith(tokenFee),
        config: { allowedUserIds: new Set([1]), dataDir: '/d', extraAllowedTargets: [], maxCreationFeeWei: {}, allowedFeeTokens: ['0x0000000000000000000000000000000000005555'] },
      }).deps,
    );
    expect(text(allowed.lines)).not.toContain('o1 meminta creation fee dalam token');

    const sixDecimals = () => {
      const cfg = configFor('tax');
      cfg.suites![0]!.creation_fee = { amount_raw: '1000000000000000', currency: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 6 };
      return cfg;
    };
    const mismatch = await runDoctor(makeDeps({ api: apiWith(sixDecimals) }).deps);
    expect(text(mismatch.lines)).toContain('menyebut creation fee native dengan 6 desimal, bot mengharapkan 18');
  });

  it('fails on a rejected Telegram token', async () => {
    const { deps } = makeDeps({
      telegramGetMe: async () => {
        throw new GrammyError('getMe failed', { ok: false, error_code: 401, description: 'Unauthorized' }, 'getMe', {});
      },
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(false);
    expect(text(report.lines)).toContain('❌ Telegram: token ditolak (401)');
  });

  it('fails when Telegram is unreachable', async () => {
    const { deps } = makeDeps({
      telegramGetMe: async () => {
        throw new HttpError('Network request failed', new Error('connect ECONNREFUSED'));
      },
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(false);
    expect(text(report.lines)).toContain('tidak bisa terhubung ke api.telegram.org');
  });

  it('stops early when no chain has a working RPC (and does not spend API calls)', async () => {
    const { deps, ping, getConfig } = makeDeps({
      wallet: {
        address: WALLET,
        verifyChains: async () => [{ chainId: 8453, ok: false, error: 'RPC mengembalikan chain id 1, seharusnya 8453' }],
        nativeBalance: async () => 0n,
      },
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(false);
    expect(text(report.lines)).toContain('Base (8453): RPC bermasalah: RPC mengembalikan chain id 1');
    expect(text(report.lines)).toContain('Tidak ada chain yang bisa dipakai');
    expect(ping).not.toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('only warns about an empty balance', async () => {
    const { deps } = makeDeps({
      wallet: { address: WALLET, verifyChains: async () => [{ chainId: 8453, ok: true }], nativeBalance: async () => 0n },
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(true);
    expect(text(report.lines)).toContain('⚠️ Base (8453): RPC OK, tetapi saldo 0');
  });

  it('keeps going with the healthy chains when another chain is broken', async () => {
    const { deps, getConfig } = makeDeps({
      wallet: {
        address: WALLET,
        verifyChains: async () => [
          { chainId: 8453, ok: true },
          { chainId: 56, ok: false, error: 'HTTP request failed.' },
        ],
        nativeBalance: async () => 10n ** 18n,
      },
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(false); // a configured chain is broken: surface it
    expect(text(report.lines)).toContain('BSC (56): RPC bermasalah');
    expect(getConfig.mock.calls.every(([chain]) => chain === 8453)).toBe(true);
  });

  it('fails on a rejected API key and skips the follow-up probes', async () => {
    const { deps, tokenIndexed, getConfig } = makeDeps();
    (deps.api.ping as ReturnType<typeof vi.fn>).mockRejectedValue(apiError(401, 'invalid_api_key'));
    const report = await runDoctor(deps);
    expect(report.ok).toBe(false);
    expect(text(report.lines)).toContain('API o1: key ditolak (invalid_api_key)');
    expect(tokenIndexed).not.toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('fails when the key lacks tokens:read', async () => {
    const { deps, tokenIndexed } = makeDeps();
    tokenIndexed.mockRejectedValue(apiError(403, 'insufficient_scope'));
    const report = await runDoctor(deps);
    expect(report.ok).toBe(false);
    expect(text(report.lines)).toContain('belum punya scope tokens:read');
  });

  it('warns when a product is not available for new launches on a chain', async () => {
    const { deps } = makeDeps();
    (deps.api.getConfig as ReturnType<typeof vi.fn>).mockImplementation(async (_c: number, opts: { product: 'tax' | 'non-tax' }) => {
      const cfg = configFor(opts.product);
      if (opts.product === 'tax') cfg.suites![0]!.creation_available = false;
      return cfg;
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(true);
    expect(text(report.lines)).toContain('⚠️ Base · Tax: belum tersedia untuk launch baru');
    expect(text(report.lines)).toContain('✅ Base · Standard: siap');
  });

  it('degrades to warnings when the catalog cannot be loaded', async () => {
    const { deps } = makeDeps();
    (deps.api.getConfig as ReturnType<typeof vi.fn>).mockRejectedValue(apiError(503, 'temporarily_unavailable'));
    const report = await runDoctor(deps);
    expect(report.ok).toBe(true);
    expect(text(report.lines)).toContain('⚠️ Base · Tax: konfigurasi tidak bisa dimuat');
  });
});
