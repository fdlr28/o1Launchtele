import { HttpError } from 'grammy';
import dotenv from 'dotenv';
import { createBot, registerCommandMenu } from './bot/app.js';
import { BackgroundTasks } from './bot/tasks.js';
import { createDownloader } from './bot/telegramFiles.js';
import { chainName } from './chains.js';
import { ConfigError, configSecrets, loadConfig, type AppConfig } from './config.js';
import { setErrorSanitizer } from './errors.js';
import { createLogger, redact } from './logger.js';
import { Catalog } from './o1/catalog.js';
import { ApiError, O1Client } from './o1/client.js';
import { pendingNotice, settledNotice } from './notices.js';
import { History, type HistoryEntry } from './services/history.js';
import { Launcher } from './services/launcher.js';
import { ViemWallet } from './wallet/wallet.js';

/**
 * How long a shutdown waits for a running launch (a launch with a dev buy can take a few minutes), then for the
 * final Telegram message about it. systemd's TimeoutStopSec (270 s in the installer) must stay above their sum.
 */
const SHUTDOWN_DRAIN_MS = 240_000;
const SHUTDOWN_REPORT_MS = 15_000;
/** bot.stop() waits for the running update handlers; a wedged one must not hold up the shutdown. */
const BOT_STOP_MS = 10_000;
/** How often unresolved launches are re-checked, so the owner hears when one turns out to have confirmed. */
const SETTLE_WATCH_MS = 60_000;
/** A network that is down at boot must not turn into a crash loop that systemd gives up on: wait it out here. */
const STARTUP_ATTEMPTS = 8;
const STARTUP_RETRY_MS = 15_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Everything printed outside the logger goes through the same redaction, once the secrets are known. */
let knownSecrets: string[] = [];
const printError = (...parts: unknown[]) => console.error(redact(parts.map((p) => (p instanceof Error ? p.message : String(p))).join(' '), knownSecrets));

async function main(): Promise<void> {
  dotenv.config({ quiet: true });

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      printError(err.message);
      process.exit(1);
    }
    throw err;
  }
  const secrets = configSecrets(config);
  knownSecrets = secrets;
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
  for (let attempt = 1; ; attempt++) {
    for (const check of await wallet.verifyChains()) {
      if (check.ok) log.info(`chain ${chainName(check.chainId)} (${check.chainId}) siap`);
      else log.warn(`chain ${chainName(check.chainId)} (${check.chainId}) dinonaktifkan: ${check.error}`);
    }
    if (wallet.enabledChains().length > 0) break;
    if (attempt >= STARTUP_ATTEMPTS) {
      log.error('Tidak ada RPC yang bisa dipakai. Periksa RPC_URL_<chainId> di .env.');
      process.exit(1);
    }
    log.warn(`Belum ada RPC yang menjawab (percobaan ${attempt}/${STARTUP_ATTEMPTS}); mencoba lagi ${STARTUP_RETRY_MS / 1000} detik lagi…`);
    await sleep(STARTUP_RETRY_MS);
  }
  const enabled = wallet.enabledChains();

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
  try {
    await history.assertWritable();
  } catch (err) {
    log.error(`Folder data (${config.dataDir}) tidak bisa ditulis: ${err instanceof Error ? err.message : String(err)}. Tanpa catatan riwayat, bot tidak akan mengirim transaksi apa pun.`);
    process.exit(1);
  }

  // Messages the bot sends on its own; wired to the Telegram bot once that exists.
  let notifyOwners: (text: string) => void = () => {};
  const launcher = new Launcher({
    api,
    catalog,
    wallet,
    history,
    log,
    extraTargets: config.extraAllowedTargets,
    onSettled: (entry, status) => notifyOwners(settledNotice(entry, status, config.explorerUrls)),
  });
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

  notifyOwners = (text) => {
    for (const userId of config.allowedUserIds) {
      // In a private chat the chat id is the user id; this fails harmlessly for users who never started the bot.
      void bot.api.sendMessage(userId, text, { link_preview_options: { is_disabled: true } }).catch(() => {});
    }
  };

  // Whatever ends the process (a signal, or Telegram refusing to be polled) must not cut a launch in half:
  // stop taking new work, let the running launch finish and report, then exit.
  // (A second SIGTERM is not caught and ends the process at once.)
  let leaving = false;
  const drainAndExit = async (why: string, exitCode: number): Promise<never> => {
    if (leaving) return new Promise<never>(() => {});
    leaving = true;
    log.info(`${why}: berhenti menerima perintah baru…`);
    const idle = launcher.drain(SHUTDOWN_DRAIN_MS);
    if (launcher.isBusy()) log.warn('ada launch yang sedang berjalan; menunggu sampai selesai (maks 4 menit)…');
    await Promise.race([bot.stop().catch((err) => log.warn('bot.stop gagal', err)), sleep(BOT_STOP_MS)]);
    const finished = await idle;
    if (!finished) log.error('launch belum selesai saat batas waktu habis. Periksa /history dan explorer setelah bot menyala lagi.');
    // The last message about the launch (result or failure) is sent after the launcher is done.
    const reported = await tasks.idle(SHUTDOWN_REPORT_MS);
    if (!reported) log.warn('pesan hasil launch belum terkirim saat batas waktu habis');
    return process.exit(finished && reported ? exitCode : 1);
  };
  process.once('SIGINT', () => void drainAndExit('SIGINT', 0));
  process.once('SIGTERM', () => void drainAndExit('SIGTERM', 0));

  // Two chores once a minute: a launch reported as unclear settles on its own later (tell the owner, free the
  // lock), and a chain whose RPC was down at boot gets another chance instead of staying off until a restart.
  const watcher = setInterval(() => {
    if (!launcher.isBusy()) void launcher.pendingLaunches().catch((err) => log.debug('pengecekan launch tertunda gagal', err));
    if (wallet.enabledChains().length < config.chainIds.length) {
      void wallet
        .verifyChains()
        .then((checks) => {
          for (const check of checks) if (check.ok && !enabled.includes(check.chainId)) log.info(`chain ${chainName(check.chainId)} (${check.chainId}) sekarang siap`);
          enabled.splice(0, enabled.length, ...wallet.enabledChains());
        })
        .catch((err) => log.debug('verifikasi ulang RPC gagal', err));
    }
  }, SETTLE_WATCH_MS);
  watcher.unref();

  log.info(`wallet launcher: ${wallet.address} · ${config.allowedUserIds.size} user diizinkan`);
  await registerCommandMenu(bot).catch((err) => log.warn('gagal mengatur menu perintah', err));
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: (me) => {
          log.info(`bot @${me.username} berjalan`);
          if (pending.length > 0) notifyOwners(pendingNotice(pending, config.explorerUrls));
        },
      });
      break;
    } catch (err) {
      // Telegram unreachable while starting: wait it out. Anything else (409: another instance polls the same
      // token, 401: bad token) will not fix itself; leave cleanly, without cutting a running launch in half.
      if (err instanceof HttpError && attempt < STARTUP_ATTEMPTS && !launcher.isBusy()) {
        log.warn(`Telegram belum bisa dihubungi (percobaan ${attempt}/${STARTUP_ATTEMPTS}); mencoba lagi ${STARTUP_RETRY_MS / 1000} detik lagi…`);
        await sleep(STARTUP_RETRY_MS);
        continue;
      }
      log.error('bot Telegram berhenti karena error', err);
      await drainAndExit('error Telegram', 1);
    }
  }
}

main().catch((err) => {
  printError('fatal:', err);
  process.exit(1);
});
