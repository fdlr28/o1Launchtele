import type { Api, Bot } from 'grammy';
import { InputError } from '../domain/units.js';
import { IMAGE_MAX_BYTES, validateImage } from '../domain/validators.js';
import { applyTextField } from './fields.js';
import { Ui, targetOf, type BotDeps } from './panel.js';
import type { BotContext } from './state.js';

/** Free-text answers to the prompt currently shown in the panel. */
export function registerInputs(bot: Bot<BotContext>, deps: BotDeps, ui: Ui): void {
  bot.on('message:text', async (ctx) => {
    const st = ctx.state;
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // unknown command
    const awaiting = st.awaiting;
    if (!awaiting || !st.draft || st.launching) {
      if (!st.draft && !st.launching) await ctx.reply('Ketik /launch untuk membuat draft launch.');
      return;
    }
    const target = targetOf(ctx);
    // Keep the chat clean: the value is shown in the panel instead.
    await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});

    if (awaiting.field === 'image') {
      return ui.prompt(target, 'image', awaiting.back, 'Kirim gambar sebagai foto atau file, bukan teks.');
    }
    if (awaiting.field === 'pairSearch') {
      st.pairUi = { ...st.pairUi, query: text.trim().slice(0, 40), page: 0 };
      st.awaiting = null;
      return ui.show(target, 'pair');
    }

    try {
      const env = await ui.fieldEnv(st.draft);
      applyTextField(st.draft, awaiting.field, text, env);
    } catch (err) {
      if (err instanceof InputError) return ui.prompt(target, awaiting.field, awaiting.back, err.message);
      throw err;
    }
    st.awaiting = null;
    await ui.show(target, awaiting.back);
  });

  bot.on('message:photo', async (ctx) => {
    // Telegram sends several sizes ascending; take the largest one that still fits the 2 MB limit.
    const sizes = ctx.message.photo;
    const best = [...sizes].reverse().find((p) => (p.file_size ?? 0) <= IMAGE_MAX_BYTES) ?? sizes[sizes.length - 1];
    if (best) await handleImage(ctx, deps, ui, { fileId: best.file_id, size: best.file_size });
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    await handleImage(ctx, deps, ui, { fileId: doc.file_id, size: doc.file_size, mime: doc.mime_type });
  });
}

interface ImageSource {
  fileId: string;
  size?: number;
  mime?: string;
}

async function handleImage(ctx: BotContext, deps: BotDeps, ui: Ui, source: ImageSource): Promise<void> {
  const st = ctx.state;
  const awaiting = st.awaiting;
  if (!awaiting || awaiting.field !== 'image' || !st.draft || st.launching) return;
  const target = targetOf(ctx);

  try {
    if (source.mime && !source.mime.startsWith('image/')) {
      throw new InputError(
        `File bukan gambar (${source.mime}). Jika ini GIF, kirim lewat menu Lampiran › File, bukan sebagai animasi.`,
      );
    }
    if (source.size !== undefined && source.size > IMAGE_MAX_BYTES) {
      throw new InputError(`Gambar terlalu besar (${(source.size / 1e6).toFixed(2)} MB). Maksimal 2 MB.`);
    }
    const bytes = await deps.downloadFile(ctx.api as Api, source.fileId);
    st.draft.image = validateImage(bytes);
  } catch (err) {
    if (err instanceof InputError) return ui.prompt(target, 'image', awaiting.back, err.message);
    deps.log.warn('image download failed', err);
    return ui.prompt(target, 'image', awaiting.back, 'Gagal mengunduh gambar dari Telegram. Coba kirim lagi.');
  }
  st.awaiting = null;
  // A new panel keeps the controls below the image the user just sent.
  await ui.show(target, awaiting.back, { forceNew: true });
}
