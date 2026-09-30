import type { Api } from 'grammy';
import { IMAGE_MAX_BYTES } from '../domain/validators.js';

/** Downloads a Telegram file by id. The token stays inside this closure and is never logged. */
export function createDownloader(botToken: string, apiRoot = 'https://api.telegram.org') {
  return async (api: Api, fileId: string): Promise<Uint8Array> => {
    const file = await api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram did not return a file path');
    const res = await fetch(`${apiRoot.replace(/\/+$/, '')}/file/bot${botToken}/${file.file_path}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Telegram file download failed with HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > IMAGE_MAX_BYTES * 2) throw new Error('File is much larger than the allowed image size');
    return new Uint8Array(await res.arrayBuffer());
  };
}
