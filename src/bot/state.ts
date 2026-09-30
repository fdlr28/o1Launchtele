import type { Context } from 'grammy';
import type { Draft } from '../domain/draft.js';
import type { PairFilter } from '../o1/catalog.js';
import type { ReviewedFee } from '../services/launcher.js';

export const FIELD_KEYS = [
  'name',
  'symbol',
  'image',
  'description',
  'website',
  'x',
  'telegram',
  'buyTax',
  'sellTax',
  'split',
  'minHolding',
  'recipient',
  'devAmount',
  'devSlippage',
  'pairSearch',
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

export function isFieldKey(value: string): value is FieldKey {
  return (FIELD_KEYS as readonly string[]).includes(value);
}

export const VIEW_NAMES = ['dash', 'tax', 'dev', 'pair', 'chain', 'review'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

export function isViewName(value: string): value is ViewName {
  return (VIEW_NAMES as readonly string[]).includes(value);
}

/** The next message (or photo) the user sends is the value for this field. */
export interface Awaiting {
  field: FieldKey;
  /** View to return to after the value is accepted or cancelled. */
  back: ViewName;
}

export interface PairUi {
  filter: PairFilter;
  query: string;
  page: number;
}

/** What the owner saw and confirmed on the review screen: the fee, and the exact draft it was computed for. */
export interface ReviewedSnapshot {
  fee: ReviewedFee;
  fingerprint: string;
}

export interface UserState {
  draft: Draft | null;
  /** The last launched draft; its reusable settings seed the next one. */
  lastDraft: Draft | null;
  /** The single "control panel" message that every view edits in place. */
  panel: { chatId: number; messageId: number } | null;
  awaiting: Awaiting | null;
  pairUi: PairUi;
  /** Set by a passing review; the launch only starts for the very draft it was made for, and aborts if the fee rises. */
  reviewed: ReviewedSnapshot | null;
  /** One-shot warning shown on the next dashboard render. */
  notice: string | null;
  launching: boolean;
}

export type BotContext = Context & { state: UserState };

export function freshState(): UserState {
  return {
    draft: null,
    lastDraft: null,
    panel: null,
    awaiting: null,
    pairUi: { filter: 'crypto', query: '', page: 0 },
    reviewed: null,
    notice: null,
    launching: false,
  };
}

/**
 * In-memory state per Telegram user. Plain mutable objects (no serialisation) so that a
 * background launch can keep updating them after the update handler has returned.
 */
export class StateStore {
  private readonly states = new Map<number, UserState>();

  get(userId: number): UserState {
    let state = this.states.get(userId);
    if (!state) {
      state = freshState();
      this.states.set(userId, state);
    }
    return state;
  }
}
