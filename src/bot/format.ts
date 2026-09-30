/** Telegram HTML parse mode only needs these three characters escaped. */
export function esc(value: string | number | bigint): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function code(value: string): string {
  return `<code>${esc(value)}</code>`;
}

export function link(label: string, url: string | null): string {
  return url ? `<a href="${esc(url).replace(/"/g, '&quot;')}">${esc(label)}</a>` : esc(label);
}

export function check(condition: boolean): string {
  return condition ? '✅' : '▫️';
}

export function bytesLabel(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

