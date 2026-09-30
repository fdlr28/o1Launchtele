import { GrammyError, HttpError } from 'grammy';
import { isAddress, zeroAddress } from 'viem';
import { CHAINS, chainName } from './chains.js';
import type { AppConfig } from './config.js';
import { formatAmount } from './domain/units.js';
import { describeError } from './errors.js';
import { Catalog, usableQuotes } from './o1/catalog.js';
import { creationFeeCap } from './services/context.js';
import { CANONICAL_PERMIT2 } from './services/guard.js';
import { ApiError, type O1Api } from './o1/client.js';
import type { Product } from './o1/types.js';
import type { ChainCheck } from './wallet/wallet.js';

/** A well-known address that is certainly not a launchpad token; used only to probe API scopes. */
const PROBE_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

export interface DoctorDeps {
  config: Pick<AppConfig, 'allowedUserIds' | 'dataDir' | 'extraAllowedTargets' | 'maxCreationFeeWei'>;
  /** The launch log: it must be writable (no transaction is sent without a durable record) and may hold unresolved launches. */
  history: {
    assertWritable(): Promise<void>;
    pending(): Promise<Array<{ txHash?: string; chainId: number; name?: string; symbol?: string }>>;
  };
  telegramGetMe: () => Promise<{ username?: string }>;
  wallet: {
    address: string;
    verifyChains(): Promise<ChainCheck[]>;
    nativeBalance(chainId: number): Promise<bigint>;
  };
  api: O1Api & { ping(chainId: number): Promise<void> };
}

export interface DoctorReport {
  /** False when something that will stop the bot from working was found. */
  ok: boolean;
  lines: string[];
}

const OK = '✅';
const WARN = '⚠️';
const FAIL = '❌';

function short(err: unknown): string {
  return describeError(err).split('\n').filter(Boolean).slice(0, 2).join(' ');
}

/**
 * Checks everything the bot needs, without sending any transaction or Telegram message and without
 * spending more than a few API units. Every line is safe to paste into a chat (no secret values).
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const lines: string[] = [];
  let ok = true;
  const pass = (text: string) => lines.push(`${OK} ${text}`);
  const warn = (text: string) => lines.push(`${WARN} ${text}`);
  const fail = (text: string) => {
    ok = false;
    lines.push(`${FAIL} ${text}`);
  };

  // 1. Telegram token
  try {
    const me = await deps.telegramGetMe();
    pass(`Telegram: token valid, bot @${me.username ?? '?'}`);
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 401) fail('Telegram: token ditolak (401). Periksa TELEGRAM_BOT_TOKEN dari @BotFather.');
    else if (err instanceof HttpError) fail(`Telegram: tidak bisa terhubung ke api.telegram.org (${short(err.error)}).`);
    else fail(`Telegram: ${short(err)}`);
  }
  pass(`${deps.config.allowedUserIds.size} user Telegram diizinkan`);
  pass(`Wallet launcher: ${deps.wallet.address}`);

  // 1b. The launch log
  try {
    await deps.history.assertWritable();
    pass(`Folder data bisa ditulis (${deps.config.dataDir})`);
  } catch (err) {
    fail(`Folder data (${deps.config.dataDir}) tidak bisa ditulis: ${short(err)}. Tanpa catatan riwayat, bot tidak akan mengirim transaksi apa pun.`);
  }
  try {
    const pending = await deps.history.pending();
    if (pending.length > 0) {
      warn(
        `Ada ${pending.length} launch yang hasilnya belum jelas (${pending.map((e) => `${e.name ?? '?'} ${e.txHash ?? ''}`.trim()).join('; ')}). ` +
          'Launch baru diblokir sampai jelas; periksa di explorer atau kirim /dismiss ya ke bot.',
      );
    }
  } catch (err) {
    fail(`Riwayat launch tidak bisa dibaca: ${short(err)}. Bot menolak launch kalau riwayatnya tidak terbaca.`);
  }

  // 2. RPC + balances
  const checks = await deps.wallet.verifyChains();
  const readyChains: number[] = [];
  for (const check of checks) {
    const label = `${chainName(check.chainId)} (${check.chainId})`;
    if (!check.ok) {
      fail(`${label}: RPC bermasalah: ${check.error ?? 'tidak diketahui'}`);
      continue;
    }
    readyChains.push(check.chainId);
    try {
      const info = CHAINS[check.chainId];
      const balance = await deps.wallet.nativeBalance(check.chainId);
      const shown = `${formatAmount(balance, info?.nativeDecimals ?? 18)} ${info?.nativeSymbol ?? ''}`.trim();
      if (balance === 0n) warn(`${label}: RPC OK, tetapi saldo 0. Isi dana untuk creation fee dan gas.`);
      else pass(`${label}: RPC OK · saldo ${shown}`);
    } catch (err) {
      warn(`${label}: RPC OK, tetapi saldo tidak bisa dibaca (${short(err)})`);
    }
  }
  if (readyChains.length === 0) {
    fail('Tidak ada chain yang bisa dipakai. Isi RPC_URL_<chainId> yang benar di .env.');
    return { ok, lines };
  }

  // 3. o1 API key and scopes
  const first = readyChains[0] as number;
  let apiReachable = true;
  try {
    await deps.api.ping(first);
    pass('API o1: key valid (scope config:read OK)');
  } catch (err) {
    apiReachable = false;
    if (err instanceof ApiError && [401, 403].includes(err.status)) {
      fail(`API o1: key ditolak (${err.code}). Buat key baru di launch.o1.exchange/developers dengan scope yang dibutuhkan.`);
    } else {
      fail(`API o1: tidak bisa dihubungi (${short(err)})`);
    }
  }

  if (apiReachable) {
    try {
      await deps.api.tokenIndexed(first, PROBE_ADDRESS);
      pass('API o1: scope tokens:read OK');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'insufficient_scope') fail('API o1: key belum punya scope tokens:read (dibutuhkan untuk dev buy).');
      else warn(`API o1: scope tokens:read tidak bisa dipastikan (${short(err)})`);
    }
    warn('Scope launches:prepare, swaps:quote, swaps:prepare tidak bisa dicek tanpa efek samping; pastikan key punya ketiganya.');

    // 4. What can actually be launched on each chain
    const catalog = new Catalog(deps.api);
    for (const chainId of readyChains) {
      for (const product of ['tax', 'non-tax'] as Product[]) {
        const label = `${chainName(chainId)} · ${product === 'tax' ? 'Tax' : 'Standard'}`;
        try {
          const entry = await catalog.get(chainId, product, { fresh: true });
          const quotes = usableQuotes(entry);
          const suite = entry.suites.find((s) => s.creation_available);
          const fee = suite?.creation_fee;
          const nativeFee = !!fee && (!isAddress(fee.currency) || fee.currency.toLowerCase() === zeroAddress);
          // A chain's native currency has fixed decimals here; the API's own number is only used for tokens.
          const feeDecimals = nativeFee ? (CHAINS[chainId]?.nativeDecimals ?? fee.decimals) : fee?.decimals;
          if (quotes.length === 0) warn(`${label}: belum tersedia untuk launch baru`);
          else pass(`${label}: siap — ${quotes.length} pair${fee ? `, creation fee ${formatAmount(BigInt(fee.amount_raw), feeDecimals ?? 18)} ${fee.symbol}` : ''}`);

          if (fee && nativeFee && BigInt(fee.amount_raw) > creationFeeCap(chainId, (id) => deps.config.maxCreationFeeWei[id])) {
            warn(`${label}: creation fee melebihi batas keamanan bot; launch akan ditolak. Kalau o1 memang menaikkannya, naikkan MAX_CREATION_FEE_${chainId} setelah kamu memverifikasinya.`);
          }
          const permit2 = suite?.contracts.permit2?.toLowerCase();
          if (permit2 && permit2 !== CANONICAL_PERMIT2 && !deps.config.extraAllowedTargets.includes(permit2)) {
            warn(
              `${label}: Permit2 chain ini (${permit2}) bukan Permit2 kanonis, jadi dev buy dengan pair ERC-20 akan ditolak. ` +
                'Kalau kamu sudah memverifikasi alamat itu, daftarkan di EXTRA_ALLOWED_TARGETS (dev buy dengan pair native tidak terpengaruh).',
            );
          }
        } catch (err) {
          warn(`${label}: konfigurasi tidak bisa dimuat (${short(err)})`);
        }
      }
    }
  }

  lines.push('');
  lines.push(ok ? `${OK} Siap. Jalankan bot dengan: npm start` : `${FAIL} Ada masalah di atas yang harus diperbaiki sebelum bot dijalankan.`);
  return { ok, lines };
}
