import dotenv from 'dotenv';
import { createBot, registerCommandMenu } from './bot/app.js';
import { createDownloader } from './bot/telegramFiles.js';
import { chainName } from './chains.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { createLogger, secretVariants } from './logger.js';
import { Catalog } from './o1/catalog.js';
import { ApiError, O1Client } from './o1/client.js';
import { History } from './services/history.js';
import { Launcher } from './services/launcher.js';
import { ViemWallet } from './wallet/wallet.js';

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
  const log = createLogger(config.logLevel, console.log, secretVariants(config.privateKey, config.o1ApiKey, config.telegramToken));

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
  const launcher = new Launcher({ api, catalog, wallet, history, log, strictTargets: config.strictTargets });
  const { bot } = createBot(
    { config, wallet, catalog, launcher, history, log, downloadFile: createDownloader(config.telegramToken, config.telegramApiRoot) },
    config.telegramToken,
    config.telegramApiRoot ? { client: { apiRoot: config.telegramApiRoot } } : {},
  );

  const stop = () => {
    log.info('menghentikan bot…');
    void bot.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  log.info(`wallet launcher: ${wallet.address} · ${config.allowedUserIds.size} user diizinkan · strict targets: ${config.strictTargets}`);
  await registerCommandMenu(bot).catch((err) => log.warn('gagal mengatur menu perintah', err));
  await bot.start({ onStart: (me) => log.info(`bot @${me.username} berjalan`) });
}

main().catch((err) => {
  console.error('fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
