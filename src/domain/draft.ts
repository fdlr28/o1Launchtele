import { randomUUID } from 'node:crypto';
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
