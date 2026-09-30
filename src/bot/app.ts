import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, type BotConfig } from 'grammy';
import { registerCallbacks } from './callbacks.js';
import { COMMAND_LIST, registerCommands } from './commands.js';
import { registerInputs } from './inputs.js';
import { Ui, type BotDeps } from './panel.js';
import { StateStore, type BotContext } from './state.js';

export interface CreatedBot {
  bot: Bot<BotContext>;
  store: StateStore;
}

/**
 * Wires the Telegram bot. Only allow-listed users in private chats can use it (except /id, which
 * exists so a new owner can find the ID to allow-list).
 */
export function createBot(deps: BotDeps, telegramToken: string, options: Partial<BotConfig<BotContext>> = {}): CreatedBot {
  const bot = new Bot<BotContext>(telegramToken, options);
  // Waits out Telegram flood limits (429) and retries transient failures instead of failing the update.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 15 }));
  const store = new StateStore();
  const ui = new Ui(deps);
  const allowed = deps.config.allowedUserIds;

  bot.command('id', (ctx) => ctx.reply(`ID Telegram kamu: <code>${ctx.from?.id ?? '?'}</code>`, { parse_mode: 'HTML' }));

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return; // never operate in groups/channels
    const userId = ctx.from?.id;
    if (userId !== undefined && allowed.has(userId)) {
      ctx.state = store.get(userId);
      return next();
    }
    deps.log.warn(`rejected update from unauthorised user ${userId ?? '?'}`);
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Akses ditolak.', show_alert: true }).catch(() => {});
    } else if (ctx.message) {
      await ctx.reply(`⛔ Akses ditolak. ID Telegram kamu: ${userId ?? '?'}.\nMinta pemilik bot menambahkannya ke ALLOWED_USER_IDS.`);
    }
  });

  registerCommands(bot, deps, ui);
  registerCallbacks(bot, deps, ui);
  registerInputs(bot, deps, ui);

  bot.catch(async (err) => {
    deps.log.error(`unhandled bot error: ${err.error instanceof Error ? err.error.stack : String(err.error)}`);
    try {
      await err.ctx.reply('⚠️ Terjadi kesalahan internal. Coba lagi, atau ketik /launch untuk membuka ulang panel.');
    } catch {
      // nothing more we can do
    }
  });

  return { bot, store };
}

export async function registerCommandMenu(bot: Bot<BotContext>): Promise<void> {
  await bot.api.setMyCommands(COMMAND_LIST);
}
