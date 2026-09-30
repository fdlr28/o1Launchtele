import type { Hex } from 'viem';
import { CHAINS, SUPPORTED_CHAIN_IDS } from './chains.js';
import type { LogLevel } from './logger.js';

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
  strictTargets: boolean;
  dataDir: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {}

const DEFAULT_API_URL = 'https://api.launch.o1.exchange/v1';
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

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
  if (telegramApiRoot && !isHttpUrl(telegramApiRoot)) errors.push('TELEGRAM_API_ROOT bukan URL http(s) yang valid.');

  const allowedUserIds = new Set<number>();
  const allowedRaw = required('ALLOWED_USER_IDS', 'ID Telegram numerik yang boleh memakai bot, pisahkan dengan koma');
  for (const part of allowedRaw.split(/[\s,]+/).filter(Boolean)) {
    if (!/^\d{1,15}$/.test(part) || Number(part) <= 0) errors.push(`ALLOWED_USER_IDS berisi nilai yang bukan ID numerik: "${part}".`);
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
  if (!isHttpUrl(o1ApiBaseUrl)) errors.push('O1_API_BASE_URL bukan URL http(s) yang valid.');

  const rpcUrls: Record<number, string> = {};
  const explorerUrls: Record<number, string> = {};
  for (const id of SUPPORTED_CHAIN_IDS) {
    const rpc = get(`RPC_URL_${id}`) ?? CHAINS[id]?.defaultRpc;
    if (get(`RPC_URL_${id}`) && !isHttpUrl(get(`RPC_URL_${id}`)!)) errors.push(`RPC_URL_${id} bukan URL http(s) yang valid.`);
    else if (rpc) rpcUrls[id] = rpc;
    const explorer = get(`EXPLORER_URL_${id}`);
    if (explorer) {
      if (isHttpUrl(explorer)) explorerUrls[id] = explorer;
      else errors.push(`EXPLORER_URL_${id} bukan URL http(s) yang valid.`);
    }
  }

  let chainIds = Object.keys(rpcUrls).map(Number);
  const enabledRaw = get('ENABLED_CHAINS');
  if (enabledRaw) {
    chainIds = [];
    for (const part of enabledRaw.split(/[\s,]+/).filter(Boolean)) {
      const id = Number(part);
      if (!SUPPORTED_CHAIN_IDS.includes(id)) errors.push(`ENABLED_CHAINS berisi chain yang tidak didukung: "${part}" (didukung: ${SUPPORTED_CHAIN_IDS.join(', ')}).`);
      else if (!rpcUrls[id]) errors.push(`Chain ${id} diaktifkan tetapi RPC_URL_${id} belum diisi.`);
      else chainIds.push(id);
    }
  }
  if (errors.length === 0 && chainIds.length === 0) {
    errors.push('Tidak ada chain aktif. Isi minimal satu RPC_URL_<chainId>, misalnya RPC_URL_8453.');
  }

  const slippageRaw = get('DEV_BUY_SLIPPAGE_BPS');
  let devBuySlippageBps = 500;
  if (slippageRaw !== undefined) {
    const n = Number(slippageRaw);
    if (!Number.isInteger(n) || n < 1 || n > 4999) errors.push('DEV_BUY_SLIPPAGE_BPS harus bilangan bulat 1-4999 (500 = 5%).');
    else devBuySlippageBps = n;
  }

  const strictRaw = get('STRICT_TARGETS')?.toLowerCase();
  if (strictRaw !== undefined && !['true', 'false'].includes(strictRaw)) errors.push('STRICT_TARGETS harus true atau false.');

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
    strictTargets: strictRaw !== 'false',
    dataDir: get('DATA_DIR') ?? './data',
    logLevel: logLevelRaw as LogLevel,
  };
}
