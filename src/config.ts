import { isAddress, parseUnits, type Hex } from 'viem';
import { CHAINS, SUPPORTED_CHAIN_IDS } from './chains.js';
import { secretVariants, urlSecrets, type LogLevel } from './logger.js';

export interface AppConfig {
  telegramToken: string;
  /** Only for a self-hosted Telegram Bot API server; defaults to api.telegram.org. */
  telegramApiRoot?: string;
  allowedUserIds: Set<number>;
  privateKey: Hex;
  o1ApiKey: string;
  o1ApiBaseUrl: string;
  /** RPC endpoint per chain (from RPC_URL_<id> or a well-known default). */
  rpcUrls: Record<number, string>;
  explorerUrls: Record<number, string>;
  /** Chains the bot will try to enable (they still have to pass the RPC chain-id check). */
  chainIds: number[];
  devBuySlippageBps: number;
  /** Contracts the owner explicitly trusts on top of those o1 publishes in /config (normally empty). */
  extraAllowedTargets: string[];
  /** Tokens (lower-case addresses) the owner accepts as a creation fee; o1 charges native fees, so normally empty. */
  allowedFeeTokens: string[];
  /** The owner's overrides (MAX_GAS_COST_<id>, MAX_CREATION_FEE_<id>, in native units) of the built-in ceilings, in wei. */
  maxGasCostWei: Record<number, bigint>;
  maxCreationFeeWei: Record<number, bigint>;
  dataDir: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {}

const DEFAULT_API_URL = 'https://api.launch.o1.exchange/v1';
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * https, or plain http to the same machine. Everything the bot talks to carries either a secret (API key,
 * bot token, an RPC key in the URL) or data that decides money movements (receipts, balances).
 */
function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

const SECURE_URL_HINT = 'harus URL https:// yang valid (http:// hanya boleh ke localhost)';

/** A value quoted in an error message is shortened: a secret may have been pasted into the wrong variable. */
const brief = (value: string): string => (value.length > 16 ? `${value.slice(0, 4)}…(${value.length} karakter)` : value);

/** Reads and validates the environment. Every problem is reported at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = [];
  const get = (name: string): string | undefined => env[name]?.trim() || undefined;
  const required = (name: string, hint: string): string => {
    const value = get(name);
    if (!value) errors.push(`${name} wajib diisi (${hint}).`);
    return value ?? '';
  };

  const telegramToken = required('TELEGRAM_BOT_TOKEN', 'token dari @BotFather');
  if (telegramToken && !/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(telegramToken)) {
    errors.push('TELEGRAM_BOT_TOKEN formatnya tidak valid (contoh: 123456789:AAH...).');
  }

  const telegramApiRoot = get('TELEGRAM_API_ROOT');
  if (telegramApiRoot && !isSecureUrl(telegramApiRoot)) errors.push(`TELEGRAM_API_ROOT ${SECURE_URL_HINT}.`);

  const allowedUserIds = new Set<number>();
  const allowedRaw = required('ALLOWED_USER_IDS', 'ID Telegram numerik yang boleh memakai bot, pisahkan dengan koma');
  for (const part of allowedRaw.split(/[\s,]+/).filter(Boolean)) {
    if (!/^\d{1,15}$/.test(part) || Number(part) <= 0) errors.push(`ALLOWED_USER_IDS berisi nilai yang bukan ID numerik: "${brief(part)}".`);
    else allowedUserIds.add(Number(part));
  }

  let privateKey = required('PRIVATE_KEY', 'private key wallet launcher');
  if (privateKey) {
    if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) errors.push('PRIVATE_KEY harus 64 karakter hex (boleh diawali 0x).');
  }

  const o1ApiKey = required('O1_API_KEY', 'buat di launch.o1.exchange/developers');
  if (o1ApiKey && !/^o1_launch_[0-9a-f]{8}_[A-Za-z0-9_-]+$/.test(o1ApiKey)) {
    errors.push('O1_API_KEY formatnya tidak valid (harus diawali o1_launch_).');
  }

  const o1ApiBaseUrl = get('O1_API_BASE_URL') ?? DEFAULT_API_URL;
  if (!isSecureUrl(o1ApiBaseUrl)) errors.push(`O1_API_BASE_URL ${SECURE_URL_HINT}.`);

  const rpcUrls: Record<number, string> = {};
  const explorerUrls: Record<number, string> = {};
  for (const id of SUPPORTED_CHAIN_IDS) {
    const rpc = get(`RPC_URL_${id}`) ?? CHAINS[id]?.defaultRpc;
    if (get(`RPC_URL_${id}`) && !isSecureUrl(get(`RPC_URL_${id}`)!)) errors.push(`RPC_URL_${id} ${SECURE_URL_HINT}.`);
    else if (rpc) rpcUrls[id] = rpc;
    const explorer = get(`EXPLORER_URL_${id}`);
    if (explorer) {
      if (isSecureUrl(explorer)) explorerUrls[id] = explorer;
      else errors.push(`EXPLORER_URL_${id} ${SECURE_URL_HINT}.`);
    }
  }

  let chainIds = Object.keys(rpcUrls).map(Number);
  const enabledRaw = get('ENABLED_CHAINS');
  if (enabledRaw) {
    chainIds = [];
    for (const part of enabledRaw.split(/[\s,]+/).filter(Boolean)) {
      const id = Number(part);
      if (!SUPPORTED_CHAIN_IDS.includes(id)) errors.push(`ENABLED_CHAINS berisi chain yang tidak didukung: "${brief(part)}" (didukung: ${SUPPORTED_CHAIN_IDS.join(', ')}).`);
      else if (!rpcUrls[id]) errors.push(`Chain ${id} diaktifkan tetapi RPC_URL_${id} belum diisi.`);
      else chainIds.push(id);
    }
  }
  if (errors.length === 0 && chainIds.length === 0) {
    errors.push('Tidak ada chain aktif. Isi minimal satu RPC_URL_<chainId>, misalnya RPC_URL_8453.');
  }

  const maxGasCostWei: Record<number, bigint> = {};
  const maxCreationFeeWei: Record<number, bigint> = {};
  for (const id of SUPPORTED_CHAIN_IDS) {
    for (const [name, target] of [['MAX_GAS_COST', maxGasCostWei], ['MAX_CREATION_FEE', maxCreationFeeWei]] as const) {
      const raw = get(`${name}_${id}`);
      if (raw === undefined) continue;
      if (!/^\d+(\.\d{1,18})?$/.test(raw) || parseUnits(raw, 18) <= 0n) errors.push(`${name}_${id} harus angka positif dalam satuan native chain, mis. 0.05.`);
      else target[id] = parseUnits(raw, 18);
    }
  }

  const slippageRaw = get('DEV_BUY_SLIPPAGE_BPS');
  let devBuySlippageBps = 500;
  if (slippageRaw !== undefined) {
    const n = Number(slippageRaw);
    if (!Number.isInteger(n) || n < 1 || n > 4999) errors.push('DEV_BUY_SLIPPAGE_BPS harus bilangan bulat 1-4999 (500 = 5%).');
    else devBuySlippageBps = n;
  }

  const extraAllowedTargets: string[] = [];
  for (const part of (get('EXTRA_ALLOWED_TARGETS') ?? '').split(/[\s,]+/).filter(Boolean)) {
    if (isAddress(part, { strict: false })) extraAllowedTargets.push(part.toLowerCase());
    else errors.push(`EXTRA_ALLOWED_TARGETS berisi alamat yang tidak valid: "${brief(part)}".`);
  }
  const allowedFeeTokens: string[] = [];
  for (const part of (get('ALLOWED_FEE_TOKENS') ?? '').split(/[\s,]+/).filter(Boolean)) {
    if (isAddress(part, { strict: false })) allowedFeeTokens.push(part.toLowerCase());
    else errors.push(`ALLOWED_FEE_TOKENS berisi alamat yang tidak valid: "${brief(part)}".`);
  }
  // The old opt-out is gone. "true" is what the bot does anyway, so a leftover line is harmless; anything else
  // would be an owner expecting a check to be off that no longer can be, and must not pass silently.
  const legacyStrict = get('STRICT_TARGETS');
  if (legacyStrict !== undefined && legacyStrict.toLowerCase() !== 'true') {
    errors.push('STRICT_TARGETS sudah dihapus: pemeriksaan target transaksi selalu aktif. Untuk mempercayai kontrak tambahan, isi EXTRA_ALLOWED_TARGETS.');
  }

  const logLevelRaw = (get('LOG_LEVEL') ?? 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) errors.push(`LOG_LEVEL harus salah satu dari: ${LOG_LEVELS.join(', ')}.`);

  if (errors.length > 0) {
    throw new ConfigError(`Konfigurasi .env tidak valid:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  return {
    telegramToken,
    telegramApiRoot,
    allowedUserIds,
    privateKey: privateKey as Hex,
    o1ApiKey,
    o1ApiBaseUrl,
    rpcUrls,
    explorerUrls,
    chainIds,
    devBuySlippageBps,
    extraAllowedTargets,
    allowedFeeTokens,
    maxGasCostWei,
    maxCreationFeeWei,
    dataDir: get('DATA_DIR') ?? './data',
    logLevel: logLevelRaw as LogLevel,
  };
}

/** Every value that must never appear in a log line or a message: keys, tokens and credential-bearing URLs. */
export function configSecrets(config: Pick<AppConfig, 'privateKey' | 'o1ApiKey' | 'telegramToken' | 'rpcUrls' | 'telegramApiRoot' | 'o1ApiBaseUrl'>): string[] {
  return [
    ...secretVariants(config.privateKey, config.o1ApiKey, config.telegramToken),
    ...Object.values(config.rpcUrls).flatMap(urlSecrets),
    ...urlSecrets(config.o1ApiBaseUrl),
    ...(config.telegramApiRoot ? urlSecrets(config.telegramApiRoot) : []),
  ];
}
