import type { Bot } from 'grammy';
import type { Address } from 'viem';
import { carryOverDraft, draftFingerprint, newDraft } from '../domain/draft.js';
import { InputError, ONE_PERCENT } from '../domain/units.js';
import { findQuote } from '../o1/catalog.js';
import { draftProblems } from '../o1/launchRequest.js';
import { applyTextField, clearField, presetSlippage, presetSplit, presetTax, setQuote } from './fields.js';
import { startLaunch } from './launch.js';
import { Ui, targetOf, toDraftQuote, type BotDeps } from './panel.js';
import { isFieldKey, isViewName, type BotContext, type UserState, type ViewName } from './state.js';

const PREFERRED_CHAIN = 8453;

/** Creates (or refreshes) the draft and puts the control panel at the bottom of the chat. */
export async function openLaunchPanel(ctx: BotContext, deps: BotDeps, ui: Ui, mode: 'auto' | 'fresh'): Promise<void> {
  const st = ctx.state;
  if (st.launching) {
    await ctx.reply('⏳ Masih ada launch yang sedang berjalan. Tunggu sampai selesai.');
    return;
  }
  const chains = ui.supportedChains();
  if (chains.length === 0) {
    await ctx.reply('⚠️ Belum ada chain yang aktif (RPC belum terverifikasi). Periksa RPC_URL_* di .env lalu restart bot.');
    return;
  }

  if (mode === 'fresh' || !st.draft) {
    const chainId = chains.includes(PREFERRED_CHAIN) ? PREFERRED_CHAIN : (chains[0] as number);
    st.draft =
      mode === 'auto' && st.lastDraft
        ? carryOverDraft(st.lastDraft)
        : newDraft({ chainId, wallet: deps.wallet.address, slippageBps: deps.config.devBuySlippageBps });
  }
  const draft = st.draft;
  if (!chains.includes(draft.chainId)) {
    draft.chainId = chains[0] as number;
    setQuote(draft, null);
  }
  st.awaiting = null;
  await ui.ensureDefaultPair(st, draft);
  await ui.show(targetOf(ctx), 'dash', { forceNew: true });
}

/** Routes every inline-button press. Callback data grammar: `<namespace>:<arg>:<arg>` (max 64 bytes). */
export function registerCallbacks(bot: Bot<BotContext>, deps: BotDeps, ui: Ui): void {
  bot.on('callback_query:data', async (ctx) => {
    const st = ctx.state;
    const data = ctx.callbackQuery.data;
    const [ns = '', a = '', b = ''] = data.split(':');
    const answer = (text?: string, alert = false) => ctx.answerCallbackQuery({ text, show_alert: alert }).catch(() => {});

    if (ns === 'noop') return void (await answer());

    // These two create a fresh draft, so they work without a live panel/draft.
    if (ns === 'go' && (a === 'again' || a === 'reset')) {
      if (st.launching) return void (await answer('Masih ada launch berjalan.', true));
      await answer();
      return openLaunchPanel(ctx, deps, ui, a === 'again' ? 'auto' : 'fresh');
    }

    const messageId = ctx.callbackQuery.message?.message_id;
    if (st.panel && messageId !== undefined && messageId !== st.panel.messageId) {
      deps.log.debug(`stale panel press: button on message ${messageId}, active panel is ${st.panel.messageId}`);
      return void (await answer('Panel ini sudah tidak aktif. Ketik /launch untuk membuka yang baru.', true));
    }
    if (st.launching) return void (await answer('Launch sedang berjalan…', true));
    const draft = st.draft;
    if (!draft) return void (await answer('Sesi kedaluwarsa. Ketik /launch untuk mulai.', true));
    const target = targetOf(ctx);

    const show = async (view: ViewName) => ui.show(target, view);

    switch (ns) {
      case 'nav': {
        if (!isViewName(a)) return void (await answer());
        st.awaiting = null;
        await answer();
        return show(a);
      }

      case 'chain': {
        const id = Number(a);
        if (!ui.supportedChains().includes(id)) return void (await answer('Chain tidak aktif.', true));
        await answer();
        draft.chainId = id;
        setQuote(draft, null);
        await ui.ensureDefaultPair(st, draft);
        return show('dash');
      }

      case 'prod': {
        await answer();
        draft.product = draft.product === 'tax' ? 'non-tax' : 'tax';
        setQuote(draft, null);
        await ui.ensureDefaultPair(st, draft);
        return show('dash');
      }

      case 'pair': {
        if (a === 'pick') {
          try {
            const entry = await deps.catalog.get(draft.chainId, draft.product);
            const quote = findQuote(entry, b as Address);
            if (!quote) return void (await answer('Pair ini tidak tersedia lagi.', true));
            setQuote(draft, toDraftQuote(quote));
          } catch {
            return void (await answer('Gagal memuat daftar pair. Coba lagi.', true));
          }
          await answer();
          return show('dash');
        }
        if (a === 'filter') st.pairUi = { filter: b === 'stocks' ? 'stocks' : 'crypto', query: '', page: 0 };
        else if (a === 'page') st.pairUi.page = Math.max(0, Number.parseInt(b, 10) || 0);
        else if (a === 'clearq') st.pairUi = { ...st.pairUi, query: '', page: 0 };
        await answer();
        return show('pair');
      }

      case 'in': {
        if (!isFieldKey(a)) return void (await answer());
        const back = isViewName(b) ? b : 'dash';
        await answer();
        return ui.prompt(target, a, back);
      }

      case 'clr': {
        if (!isFieldKey(a)) return void (await answer());
        clearField(draft, a);
        st.awaiting = null;
        await answer();
        return show(isViewName(b) ? b : 'dash');
      }

      case 'cancel': {
        st.awaiting = null;
        await answer();
        return show(isViewName(a) ? a : 'dash');
      }

      case 'tog': {
        let view: ViewName = 'dash';
        if (a === 'edit') draft.editableMetadata = !draft.editableMetadata;
        else if (a === 'anti') {
          draft.tax.antiSnipe = !draft.tax.antiSnipe;
          view = 'tax';
        } else if (a === 'dev') {
          if (!draft.devBuy.enabled && !draft.quote) return void (await answer('Pilih pair dulu.', true));
          draft.devBuy.enabled = !draft.devBuy.enabled;
          view = 'dev';
        } else if (a === 'timing') {
          draft.devBuy.timing = draft.devBuy.timing === 'auto' ? 'now' : 'auto';
          view = 'dev';
        }
        await answer();
        return show(view);
      }

      case 'pre': {
        const env = await ui.fieldEnv(draft);
        let view: ViewName = 'tax';
        try {
          if (a === 'tax') presetTax(draft, BigInt(Number.parseInt(b, 10) || 0) * ONE_PERCENT, env);
          else if (a === 'split') presetSplit(draft, Number.parseInt(b, 10), env);
          else if (a === 'hold') applyTextField(draft, 'minHolding', b, env);
          else if (a === 'slip') {
            presetSlippage(draft, Number.parseInt(b, 10));
            view = 'dev';
          } else if (a === 'self') draft.tax.creatorRecipient = deps.wallet.address;
        } catch (err) {
          if (err instanceof InputError) return void (await answer(err.message, true));
          throw err;
        }
        await answer();
        return show(view);
      }

      case 'go': {
        if (a !== 'launch') return void (await answer());
        return handleLaunch(ctx, st, deps, ui, answer);
      }

      default:
        return void (await answer());
    }
  });
}

async function handleLaunch(
  ctx: BotContext,
  st: UserState,
  deps: BotDeps,
  ui: Ui,
  answer: (text?: string, alert?: boolean) => Promise<unknown>,
): Promise<void> {
  const draft = st.draft;
  if (!draft) return void (await answer('Sesi kedaluwarsa.', true));
  if (!st.reviewed) return void (await answer('Buka Review dulu sebelum launch.', true));
  if (st.reviewed.fingerprint !== draftFingerprint(draft)) {
    st.reviewed = null;
    return void (await answer('Draft berubah sejak Review. Buka Review lagi lalu konfirmasi.', true));
  }
  if (deps.launcher.isBusy()) return void (await answer('Launcher sedang dipakai. Coba lagi sebentar.', true));

  // Cheap local re-check; the launcher re-validates everything against fresh /config anyway.
  const env = await ui.fieldEnv(draft);
  const problems = draftProblems(draft, env.suite);
  if (problems.length > 0) return void (await answer(problems[0], true));

  await answer('Memulai launch…');
  await startLaunch(targetOf(ctx), deps, ui);
}
