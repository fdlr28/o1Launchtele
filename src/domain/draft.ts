import { createHash, randomUUID } from 'node:crypto';
import type { Address } from 'viem';
import type { AssetType, Product, Route } from '../o1/types.js';
import { defaultTaxSettings, type TaxSettings } from './tax.js';
import type { ImageType } from './validators.js';

export interface DraftQuote {
  address: Address;
  symbol: string;
  name?: string;
  decimals: number;
  route: Route;
  assetType?: AssetType | null;
}

export interface DevBuySettings {
  enabled: boolean;
  /** Buy amount in the quote asset's base units; null until the user enters one. */
  amountRaw: string | null;
  slippageBps: number;
  /** "auto" waits for the anti-snipe surcharge to decay before buying; "now" buys as soon as the token is indexed. */
  timing: 'auto' | 'now';
}

export interface DraftImage {
  type: ImageType;
  base64: string;
  bytes: number;
}

export interface Draft {
  id: string;
  chainId: number;
  product: Product;
  quote: DraftQuote | null;
  name: string | null;
  symbol: string | null;
  image: DraftImage | null;
  description: string;
  website: string;
  x: string;
  telegram: string;
  editableMetadata: boolean;
  tax: TaxSettings;
  devBuy: DevBuySettings;
}

export const DEFAULT_DEV_BUY_SLIPPAGE_BPS = 500;

export function newDraft(opts: { chainId: number; wallet: Address; slippageBps?: number }): Draft {
  return {
    id: randomUUID(),
    chainId: opts.chainId,
    product: 'tax',
    quote: null,
    name: null,
    symbol: null,
    image: null,
    description: '',
    website: '',
    x: '',
    telegram: '',
    editableMetadata: false,
    tax: defaultTaxSettings(opts.wallet),
    devBuy: {
      enabled: false,
      amountRaw: null,
      slippageBps: opts.slippageBps ?? DEFAULT_DEV_BUY_SLIPPAGE_BPS,
      timing: 'auto',
    },
  };
}

/**
 * A fresh draft that keeps the reusable launch settings of a previous one
 * (chain, product, pair, tax, socials, dev buy) but needs a new name, symbol and image.
 */
export function carryOverDraft(previous: Draft): Draft {
  return {
    ...structuredClone(previous),
    id: randomUUID(),
    name: null,
    symbol: null,
    image: null,
    description: '',
  };
}

/** JSON with sorted keys, so equal drafts always serialise to the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(typeof value === 'bigint' ? value.toString() : value) ?? 'null';
}

/**
 * Digest of everything that ends up in a launch. A review is only valid for the draft state it was made
 * for: if anything changes afterwards, the fingerprint differs and the owner has to review again.
 */
export function draftFingerprint(draft: Draft): string {
  const image = draft.image ? { type: draft.image.type, bytes: draft.image.bytes, sha256: createHash('sha256').update(draft.image.base64).digest('hex') } : null;
  return createHash('sha256').update(canonical({ ...draft, image })).digest('hex');
}

/** Required fields that are still empty, in Indonesian, for the review screen. */
export function missingFields(draft: Draft): string[] {
  const missing: string[] = [];
  if (!draft.quote) missing.push('Pair (quote token)');
  if (!draft.name) missing.push('Nama');
  if (!draft.symbol) missing.push('Simbol');
  if (!draft.image) missing.push('Gambar');
  if (draft.devBuy.enabled && !draft.devBuy.amountRaw) missing.push('Jumlah dev buy');
  return missing;
}
