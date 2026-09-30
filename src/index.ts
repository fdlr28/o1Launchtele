import dotenv from 'dotenv';
import { createBot, registerCommandMenu } from './bot/app.js';
import { BackgroundTasks } from './bot/tasks.js';
import { createDownloader } from './bot/telegramFiles.js';
import { chainName, txUrl } from './chains.js';
import { ConfigError, configSecrets, loadConfig, type AppConfig } from './config.js';
import { setErrorSanitizer } from './errors.js';
import { createLogger, redact } from './logger.js';
import { Catalog } from './o1/catalog.js';
import { ApiError, O1Client } from './o1/client.js';
import { History, type HistoryEntry } from './services/history.js';
import { Launcher } from './services/launcher.js';
import { ViemWallet } from './wallet/wallet.js';

/** How long a shutdown waits for a running launch. systemd's TimeoutStopSec must be comfortably longer. */
const SHUTDOWN_DRAIN_MS = 120_000;
/** ... and then for the final Telegram message of that launch. Together still below TimeoutStopSec=150. */
const SHUTDOWN_REPORT_MS = 15_000;

function pendingNotice(pending: HistoryEntry[], explorerUrls: AppConfig['explorerUrls']): string {
  const rows = pending.map((e) => {
    const url = e.txHash ? txUrl(e.chainId, e.txHash, explorerUrls) : null;
    return `• ${e.name ?? '?'} ($${e.symbol ?? '?'}) · ${chainName(e.chainId)} · ${url ?? e.txHash ?? '?'}`;
  });
  return [
    '⚠️ Bot baru saja menyala dan menemukan launch yang hasilnya belum jelas:',
    ...rows,
    '',
    'Launch baru diblokir sampai ini jelas, supaya tidak terjadi dobel. Periksa transaksinya di explorer.',
    'Kalau kamu yakin tidak akan terkonfirmasi, kirim /dismiss ya.',
  ].join('\n');
}

async function main(): Promise<void> {
  dotenv.config({ quiet: true });

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const secrets = configSecrets(config);
  const log = createLogger(config.logLevel, console.log, secrets);
  // Third-party errors (an RPC URL with a key inside, say) must not reach Telegram messages either.
  setErrorSanitizer((text) => redact(text, secrets));

  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason));
  process.on('uncaughtException', (err) => log.error('uncaught exception', err));

  const wallet = new ViemWallet(
    config.privateKey,
    config.chainIds.map((chainId) => ({ chainId, rpcUrl: config.rpcUrls[chainId] as string })),
    log,
  );
  for (const check of await wallet.verifyChains()) {
    if (check.ok) log.info(`chain ${chainName(check.chainId)} (${check.chainId}) siap`);
    else log.warn(`chain ${chainName(check.chainId)} (${check.chainId}) dinonaktifkan: ${check.error}`);
  }
  const enabled = wallet.enabledChains();
  if (enabled.length === 0) {
    log.error('Tidak ada RPC yang bisa dipakai. Periksa RPC_URL_<chainId> di .env.');
    process.exit(1);
  }

  const api = new O1Client({ baseUrl: config.o1ApiBaseUrl, apiKey: config.o1ApiKey, log });
  try {
    await api.ping(enabled[0] as number);
    log.info('API o1 terhubung, API key valid');
  } catch (err) {
    if (err instanceof ApiError && [401, 403].includes(err.status)) {
      log.error(`API key o1 ditolak (${err.code}). Buat key baru di launch.o1.exchange/developers dengan scope: config:read, tokens:read, launches:prepare, swaps:quote, swaps:prepare.`);
      process.exit(1);
    }
    log.warn(`Tidak bisa memastikan API o1 saat startup (${err instanceof Error ? err.message : String(err)}). Bot tetap dijalankan.`);
  }

  const catalog = new Catalog(api);
  const history = new History(config.dataDir);
  const launcher = new Launcher({ api, catalog, wallet, history, log, extraTargets: config.extraAllowedTargets });
  if (config.extraAllowedTargets.length > 0) {
    log.warn(`EXTRA_ALLOWED_TARGETS aktif: ${config.extraAllowedTargets.join(', ')} boleh dipanggil/di-approve selain kontrak resmi o1.`);
  }

  // A launch that was sent before a crash or restart may still be unresolved: it blocks new launches.
  const pending = await launcher.pendingLaunches().catch((err) => {
    log.warn('riwayat launch tidak bisa diperiksa saat startup', err);
    return [] as HistoryEntry[];
  });
  for (const entry of pending) log.warn(`launch tertunda: ${entry.txHash} (chain ${entry.chainId}, status ${entry.status})`);

  const tasks = new BackgroundTasks();
  const { bot } = createBot(
    { config, wallet, catalog, launcher, history, log, tasks, downloadFile: createDownloader(config.telegramToken, config.telegramApiRoot) },
    config.telegramToken,
    config.telegramApiRoot ? { client: { apiRoot: config.telegramApiRoot } } : {},
  );

  // A signal must never cut a launch in half: stop taking new work, let the running launch finish, then exit.
  // (A second signal is not caught and ends the process at once.)
  const shutdown = async (signal: string) => {
    log.info(`${signal}: berhenti menerima perintah baru…`);
    const idle = launcher.drain(SHUTDOWN_DRAIN_MS);
    if (launcher.isBusy()) log.warn('ada launch yang sedang berjalan; menunggu sampai selesai (maks 2 menit)…');
    await bot.stop().catch((err) => log.warn('bot.stop gagal', err));
    const finished = await idle;
    if (!finished) log.error('launch belum selesai saat batas waktu habis. Periksa /history dan explorer setelah bot menyala lagi.');
    // The last message about the launch (result or failure) is sent after the launcher is done.
    const reported = await tasks.idle(SHUTDOWN_REPORT_MS);
    if (!reported) log.warn('pesan hasil launch belum terkirim saat batas waktu habis');
    process.exit(finished && reported ? 0 : 1);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  log.info(`wallet launcher: ${wallet.address} · ${config.allowedUserIds.size} user diizinkan`);
  await registerCommandMenu(bot).catch((err) => log.warn('gagal mengatur menu perintah', err));
  await bot.start({
    onStart: (me) => {
      log.info(`bot @${me.username} berjalan`);
      if (pending.length === 0) return;
      const text = pendingNotice(pending, config.explorerUrls);
      for (const userId of config.allowedUserIds) {
        // In a private chat the chat id is the user id; this fails harmlessly for users who never started the bot.
        void bot.api.sendMessage(userId, text, { link_preview_options: { is_disabled: true } }).catch(() => {});
      }
    },
  });
}

main().catch((err) => {
  console.error('fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
