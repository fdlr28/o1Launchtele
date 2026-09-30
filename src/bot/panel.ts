import { GrammyError, type Api, type InlineKeyboard } from 'grammy';
import { CHAINS, addressUrl, chainName, txUrl } from '../chains.js';
import type { AppConfig } from '../config.js';
import type { Draft, DraftQuote } from '../domain/draft.js';
import { readTaxPolicy } from '../domain/tax.js';
import { describeError } from '../errors.js';
import type { Logger } from '../logger.js';
import { Catalog, defaultPair, findQuote, listPairs, suiteForQuote, usableQuotes } from '../o1/catalog.js';
import type { ContractSuite, QuoteConfiguration } from '../o1/types.js';
import type { Launcher } from '../services/launcher.js';
import type { History } from '../services/history.js';
import { buildReview } from '../services/review.js';
import type { Wallet } from '../wallet/wallet.js';
import { setQuote, type FieldEnv } from './fields.js';
import {
  PAIR_PAGE_SIZE,
  chainKeyboard,
  dashboardKeyboard,
  devKeyboard,
  pairKeyboard,
  promptKeyboard,
  reviewKeyboard,
  taxKeyboard,
} from './keyboards.js';
import type { BotContext, FieldKey, UserState, ViewName } from './state.js';
import {
  chainViewText,
  dashboardText,
  devViewText,
  pairViewText,
  promptText,
  reviewText,
  taxViewText,
  type Explorer,
} from './texts.js';
import { formatTokenAmount } from '../domain/units.js';

export interface BotDeps {
  config: AppConfig;
  wallet: Wallet;
  catalog: Catalog;
  launcher: Launcher;
  history: History;
  log: Logger;
  /** Downloads a Telegram file (injected so tests need no network). */
  downloadFile: (api: Api, fileId: string) => Promise<Uint8Array>;
}

/** Where a panel lives; built from a context or, for background work, from saved ids. */
export interface Target {
  api: Api;
  chatId: number;
  state: UserState;
}

export function targetOf(ctx: BotContext): Target {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) throw new Error('update has no chat');
  return { api: ctx.api, chatId, state: ctx.state };
}

export interface Rendered {
  text: string;
  keyboard: InlineKeyboard;
}

const SEND_OPTS = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && /message is not modified/i.test(err.description);
}

/** The message was deleted or can no longer be edited, so a replacement should be sent. */
function isGone(err: unknown): boolean {
  return err instanceof GrammyError && /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(err.description);
}

export function toDraftQuote(q: QuoteConfiguration): DraftQuote {
  return { address: q.address, symbol: q.symbol, name: q.name, decimals: q.decimals, route: q.route, assetType: q.asset_type };
}

export class Ui {
  constructor(private readonly deps: BotDeps) {}

  chainName(chainId: number): string {
    return chainName(chainId);
  }

  explorer(chainId: number): Explorer {
    const overrides = this.deps.config.explorerUrls;
    return (kind, value) => (kind === 'tx' ? txUrl(chainId, value, overrides) : addressUrl(chainId, value, overrides));
  }

  /** Tax policy + supply of the selected chain (Tax drafts only). Never throws. */
  async fieldEnv(draft: Draft): Promise<FieldEnv & { suite?: ContractSuite }> {
    if (draft.product !== 'tax') return { taxPolicy: null, supplyRaw: null };
    try {
      const entry = await this.deps.catalog.get(draft.chainId, 'tax');
      const quote = draft.quote ? findQuote(entry, draft.quote.address) : undefined;
      const suite = (quote && suiteForQuote(entry, quote)) ?? entry.suites.find((s) => s.creation_available) ?? entry.suites[0];
      return {
        taxPolicy: suite ? readTaxPolicy(suite) : null,
        supplyRaw: suite?.launch_supply_raw ? BigInt(suite.launch_supply_raw) : null,
        suite,
      };
    } catch (err) {
      this.deps.log.debug('fieldEnv failed', err);
      return { taxPolicy: null, supplyRaw: null };
    }
  }

  /** Keeps the selected pair valid for the current chain/product and pre-selects the native pair. */
  async ensureDefaultPair(state: UserState, draft: Draft): Promise<void> {
    try {
      const entry = await this.deps.catalog.get(draft.chainId, draft.product);
      const current = draft.quote ? findQuote(entry, draft.quote.address) : undefined;
      if (current) {
        setQuote(draft, toDraftQuote(current));
        return;
      }
      const fallback = defaultPair(entry);
      setQuote(draft, fallback ? toDraftQuote(fallback) : null);
      if (!fallback) {
        state.notice = `Belum ada pair yang tersedia untuk launch ${draft.product === 'tax' ? 'Tax' : 'Standard'} di ${this.chainName(draft.chainId)}.`;
      }
    } catch (err) {
      state.notice = `Gagal mengambil konfigurasi o1: ${describeError(err).split('\n')[0]}`;
    }
  }

  async render(view: ViewName, state: UserState): Promise<Rendered> {
    const draft = state.draft;
    if (!draft) throw new Error('no draft');
    const name = this.chainName(draft.chainId);

    switch (view) {
      case 'dash': {
        const env = await this.fieldEnv(draft);
        const notice = state.notice;
        state.notice = null;
        return {
          text: dashboardText({ draft, wallet: this.deps.wallet.address, chainName: name, policy: env.taxPolicy, notice }),
          keyboard: dashboardKeyboard(draft, name),
        };
      }
      case 'chain':
        return { text: chainViewText(), keyboard: chainKeyboard(this.deps.wallet.enabledChains(), draft.chainId) };
      case 'tax': {
        const env = await this.fieldEnv(draft);
        return { text: taxViewText(draft, env.taxPolicy, name), keyboard: taxKeyboard(draft, env.taxPolicy) };
      }
      case 'dev': {
        const env = await this.fieldEnv(draft);
        return { text: devViewText(draft, env.suite), keyboard: devKeyboard(draft) };
      }
      case 'pair': {
        const entry = await this.deps.catalog.get(draft.chainId, draft.product);
        const hasStocks = usableQuotes(entry).some((q) => q.route === 'rwa');
        if (!hasStocks) state.pairUi.filter = 'crypto';
        const all = listPairs(entry, state.pairUi.filter, state.pairUi.query);
        const pages = Math.max(1, Math.ceil(all.length / PAIR_PAGE_SIZE));
        state.pairUi.page = Math.min(Math.max(0, state.pairUi.page), pages - 1);
        return {
          text: pairViewText({
            chainName: name,
            productLabel: draft.product === 'tax' ? 'Tax' : 'Standard',
            filter: state.pairUi.filter,
            query: state.pairUi.query,
            page: state.pairUi.page,
            pages,
            total: all.length,
            hasStocks,
            current: draft.quote?.symbol ?? null,
          }),
          keyboard: pairKeyboard(all, state.pairUi, hasStocks, draft.quote?.address),
        };
      }
      case 'review': {
        const review = await buildReview({ catalog: this.deps.catalog, wallet: this.deps.wallet }, draft);
        state.reviewedFeeRaw = review.ctx ? (review.ctx.fee?.isNative ? review.ctx.fee.amountRaw : 0n) : null;
        return {
          text: reviewText(draft, review, name, this.deps.wallet.address),
          keyboard: reviewKeyboard(review.ok),
        };
      }
    }
  }

  /** Renders a view into the panel. Failures fall back to the dashboard with a notice. */
  async show(target: Target, view: ViewName, opts: { forceNew?: boolean } = {}): Promise<void> {
    let rendered: Rendered;
    try {
      rendered = await this.render(view, target.state);
    } catch (err) {
      if (view === 'dash') throw err;
      target.state.notice = describeError(err).split('\n')[0] ?? null;
      rendered = await this.render('dash', target.state);
    }
    await this.upsert(target, rendered, opts);
  }

  /** Turns the panel into an input prompt for one field. */
  async prompt(target: Target, field: FieldKey, back: ViewName, error?: string): Promise<void> {
    const draft = target.state.draft;
    if (!draft) throw new Error('no draft');
    target.state.awaiting = { field, back };
    const env = await this.fieldEnv(draft);
    const floor = env.taxPolicy?.minHoldingFloor ?? 10_000n * 10n ** 18n;
    const text = promptText(field, { policy: env.taxPolicy, quoteSymbol: draft.quote?.symbol, holdingFloorText: `${formatTokenAmount(floor)} token` }, error);
    await this.upsert(target, { text, keyboard: promptKeyboard(field, back) });
  }

  /** Edits the panel message in place, or sends a fresh one when there is none / it vanished. */
  async upsert(target: Target, rendered: Rendered, opts: { forceNew?: boolean } = {}): Promise<void> {
    const { api, chatId, state } = target;
    const options = { ...SEND_OPTS, reply_markup: rendered.keyboard };
    if (state.panel && !opts.forceNew) {
      try {
        await api.editMessageText(state.panel.chatId, state.panel.messageId, rendered.text, options);
        return;
      } catch (err) {
        if (isNotModified(err)) return;
        // Rate limits and network errors must not turn into a stream of new messages.
        if (!isGone(err)) throw err;
        this.deps.log.debug('panel message is gone, sending a new one');
      }
    }
    if (state.panel && opts.forceNew) {
      await api.deleteMessage(state.panel.chatId, state.panel.messageId).catch(() => {});
    }
    const sent = await api.sendMessage(chatId, rendered.text, options);
    state.panel = { chatId, messageId: sent.message_id };
  }

  /** Replaces the panel with a final message (no tracking afterwards), e.g. a launch result. */
  async finish(target: Target, rendered: Rendered): Promise<void> {
    await this.upsert(target, rendered);
    target.state.panel = null;
  }

  supportedChains(): number[] {
    return this.deps.wallet.enabledChains().filter((id) => id in CHAINS);
  }
}
