import type { BotError } from 'grammy';
import { vi } from 'vitest';
import { createBot } from '../src/bot/app.js';
import type { BotContext } from '../src/bot/state.js';
import { BackgroundTasks } from '../src/bot/tasks.js';
import type { BotDeps } from '../src/bot/panel.js';
import type { UserState } from '../src/bot/state.js';
import type { AppConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { Catalog } from '../src/o1/catalog.js';
import { History } from '../src/services/history.js';
import { Launcher } from '../src/services/launcher.js';
import { FakeApi, FakeClock, FakeWallet, tempDir } from './fakes.js';
import { lintOutgoingCall } from './telegram-lint.js';

export const OWNER = 42;
export const STRANGER = 7;
const TOKEN = '123456789:TESTTOKENTESTTOKENTESTTOKENTESTTOK';

export interface ApiCall {
  method: string;
  payload: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface Button {
  text: string;
  data: string;
}

export function createHarness() {
  const clock = new FakeClock();
  const api = new FakeApi(clock);
  const wallet = new FakeWallet();
  const dataDir = tempDir();
  const history = new History(dataDir);
  const catalog = new Catalog(api);
  const launcher = new Launcher({ api, catalog, wallet, history, log: silentLogger, sleep: clock.sleep, now: clock.now });
  const files = new Map<string, Uint8Array>();
  const tasks = new BackgroundTasks();

  const config: AppConfig = {
    telegramToken: TOKEN,
    allowedUserIds: new Set([OWNER]),
    privateKey: `0x${'11'.repeat(32)}`,
    o1ApiKey: 'o1_launch_abcdef12_secret',
    o1ApiBaseUrl: 'https://api.test/v1',
    rpcUrls: { 8453: 'https://rpc.test' },
    explorerUrls: {},
    chainIds: [8453],
    devBuySlippageBps: 500,
    extraAllowedTargets: [],
    dataDir,
    logLevel: 'error',
  };

  const deps: BotDeps = {
    config,
    wallet,
    catalog,
    launcher,
    history,
    log: silentLogger,
    tasks,
    downloadFile: async (_api, fileId) => {
      const bytes = files.get(fileId);
      if (!bytes) throw new Error(`no such fake file ${fileId}`);
      return bytes;
    },
  };

  const botInfo = {
    id: 1, is_bot: true, first_name: 'Bot', username: 'o1_test_bot', can_join_groups: false,
    can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
    has_main_web_app: false,
  } as never;
  const { bot, store } = createBot(deps, TOKEN, { botInfo });

  /** Errors thrown by handlers or produced by lint. Production routes handler errors to bot.catch(); tests must expect them explicitly. */
  const errors: unknown[] = [];
  const calls: ApiCall[] = [];
  let nextMessageId = 1000;
  /** Make a Telegram method fail, e.g. { editMessageText: { error_code: 429, description: '...' } }. */
  const faults: Record<string, { error_code: number; description: string } | null> = {};
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as ApiCall['payload'] });
    // Anything Telegram would reject (bad HTML, oversize callback data, ...) is a bug in the bot.
    for (const problem of lintOutgoingCall(method, payload as Record<string, unknown>)) {
      errors.push(new Error(`Telegram would reject ${method}: ${problem}`));
    }
    const fault = faults[method];
    if (fault) return { ok: false, ...fault } as never;
    if (method === 'sendMessage') {
      const p = payload as ApiCall['payload'];
      return { ok: true, result: { message_id: nextMessageId++, date: 0, chat: { id: p.chat_id, type: 'private' }, text: p.text } } as never;
    }
    return { ok: true, result: true } as never;
  });

  const feed = async (update: unknown) => {
    try {
      await bot.handleUpdate(update as never);
    } catch (err) {
      errors.push((err as BotError).error ?? err);
      await bot.errorHandler(err as BotError<BotContext>);
    }
    // replies that the bot deliberately does not await (to strangers) still have to reach the fake API
    await new Promise((resolve) => setImmediate(resolve));
  };

  let updateId = 1;
  let messageId = 1;
  const user = (id: number) => ({ id, is_bot: false, first_name: 'T' });
  const chat = (id: number, type = 'private') => ({ id, type, first_name: 'T' });

  async function send(message: Record<string, unknown>, userId = OWNER, chatType = 'private') {
    await feed({
      update_id: updateId++,
      message: { message_id: messageId++, date: 0, chat: chat(userId, chatType), from: user(userId), ...message },
    });
  }

  const h = {
    clock, api, wallet, launcher, history, store, bot, calls, config, files, dataDir, faults, errors, tasks,
    /** Set to true in tests that deliberately provoke a handler error. */
    allowErrors: false,

    state(userId = OWNER): UserState {
      return store.get(userId);
    },

    async text(text: string, userId = OWNER) {
      await send({ text }, userId);
    },

    async command(name: string, userId = OWNER, chatType = 'private', args = '') {
      const head = `/${name}`;
      await send({ text: args ? `${head} ${args}` : head, entities: [{ type: 'bot_command', offset: 0, length: head.length }] }, userId, chatType);
    },

    async photo(fileId: string, size = 1000, userId = OWNER) {
      await send({ photo: [{ file_id: `${fileId}-small`, file_unique_id: 'a', width: 90, height: 90, file_size: 100 }, { file_id: fileId, file_unique_id: 'b', width: 800, height: 800, file_size: size }] }, userId);
    },

    async document(fileId: string, mime: string, size = 1000, userId = OWNER) {
      await send({ document: { file_id: fileId, file_unique_id: 'd', file_name: 'x', mime_type: mime, file_size: size } }, userId);
    },

    /** Presses an inline button. Defaults to the current panel message. */
    async press(data: string, opts: { userId?: number; messageId?: number } = {}) {
      const userId = opts.userId ?? OWNER;
      const msgId = opts.messageId ?? h.state(userId).panel?.messageId ?? 1;
      await feed({
        update_id: updateId++,
        callback_query: {
          id: `cb${updateId}`,
          from: user(userId),
          chat_instance: 'ci',
          data,
          message: { message_id: msgId, date: 0, chat: chat(userId), text: 'panel' },
        },
      });
    },

    // -------- inspection helpers --------
    /** Text of the most recent panel render (send or edit). */
    panelText(): string {
      const last = [...calls].reverse().find((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
      return String(last?.payload.text ?? '');
    },
    panelButtons(): Button[] {
      const last = [...calls].reverse().find((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.payload.reply_markup);
      const rows = (last?.payload.reply_markup?.inline_keyboard ?? []) as Array<Array<{ text: string; callback_data?: string }>>;
      return rows.flat().map((b) => ({ text: b.text, data: b.callback_data ?? '' }));
    },
    hasButton(data: string): boolean {
      return h.panelButtons().some((b) => b.data === data);
    },
    called(method: string): ApiCall[] {
      return calls.filter((c) => c.method === method);
    },
    alerts(): string[] {
      return h.called('answerCallbackQuery').filter((c) => c.payload.show_alert).map((c) => String(c.payload.text));
    },
    sentTexts(): string[] {
      return h.called('sendMessage').map((c) => String(c.payload.text));
    },

    /** Waits for a background launch to finish. */
    async settled() {
      await vi.waitFor(() => {
        if (h.state().launching) throw new Error('still launching');
      }, { timeout: 5000, interval: 5 });
    },
  };
  return h;
}

export type Harness = ReturnType<typeof createHarness>;

export const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
