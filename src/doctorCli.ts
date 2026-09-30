import { Api } from 'grammy';
import dotenv from 'dotenv';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { redact, secretVariants } from './logger.js';
import { O1Client } from './o1/client.js';
import { ViemWallet } from './wallet/wallet.js';

/** `npm run doctor`: checks the setup (.env, Telegram, RPC, wallet, o1 API) without sending anything. */
async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Defence in depth: nothing printed may contain a secret, even inside a third-party error message.
  const secrets = secretVariants(config.privateKey, config.o1ApiKey, config.telegramToken);
  const print = (line: string) => console.log(redact(line, secrets));
  print('✅ .env terbaca dan formatnya valid');

  const telegram = new Api(config.telegramToken, config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : {});
  const wallet = new ViemWallet(
    config.privateKey,
    config.chainIds.map((chainId) => ({ chainId, rpcUrl: config.rpcUrls[chainId] as string })),
  );
  const api = new O1Client({ baseUrl: config.o1ApiBaseUrl, apiKey: config.o1ApiKey });

  const report = await runDoctor({ config, telegramGetMe: () => telegram.getMe(), wallet, api });
  for (const line of report.lines) print(line);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
