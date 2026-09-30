/**
 * Checks that mirror what the Telegram Bot API enforces, so a screen that Telegram would reject
 * (and therefore break the bot for real users) fails the tests instead.
 */

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'tg-spoiler', 'blockquote']);
const TEXT_LIMIT = 4096;
const CALLBACK_DATA_LIMIT = 64;

/** Problems in a message that is sent with parse_mode=HTML. Empty = Telegram will accept it. */
export function lintTelegramHtml(text: string): string[] {
  const problems: string[] = [];
  if (text.length === 0) problems.push('empty message text');
  if (text.length > TEXT_LIMIT) problems.push(`text is ${text.length} chars (limit ${TEXT_LIMIT})`);

  const stack: string[] = [];
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>/g;
  const checkText = (segment: string) => {
    if (/[<>]/.test(segment)) problems.push(`unescaped < or > in text: ${JSON.stringify(segment.slice(0, 40))}`);
    if (/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)/.test(segment)) {
      problems.push(`unescaped & in text: ${JSON.stringify(segment.slice(0, 40))}`);
    }
  };

  let last = 0;
  for (let match = tag.exec(text); match; match = tag.exec(text)) {
    checkText(text.slice(last, match.index));
    last = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = (match[2] ?? '').toLowerCase();
    const attrs = match[3] ?? '';
    if (!ALLOWED_TAGS.has(name)) {
      problems.push(`unsupported tag <${name}>`);
      continue;
    }
    if (closing) {
      if (stack.pop() !== name) problems.push(`mismatched closing tag </${name}>`);
    } else {
      if (name === 'a' && !/href="[^"]+"/.test(attrs)) problems.push('<a> without a quoted href');
      stack.push(name);
    }
  }
  checkText(text.slice(last));
  if (stack.length > 0) problems.push(`unclosed tags: ${stack.join(', ')}`);
  return problems;
}

interface Markup {
  inline_keyboard?: Array<Array<{ text?: string; callback_data?: string; url?: string }>>;
}

/** Problems in an inline keyboard. */
export function lintInlineKeyboard(markup: Markup | undefined): string[] {
  const problems: string[] = [];
  const rows = markup?.inline_keyboard ?? [];
  if (rows.flat().length > 100) problems.push('more than 100 buttons');
  rows.forEach((row, r) => {
    if (row.length > 8) problems.push(`row ${r} has ${row.length} buttons (limit 8)`);
    for (const button of row) {
      if (!button.text || button.text.trim().length === 0) problems.push(`row ${r}: button with empty label`);
      if (button.callback_data !== undefined) {
        const bytes = Buffer.byteLength(button.callback_data, 'utf8');
        if (bytes === 0 || bytes > CALLBACK_DATA_LIMIT) problems.push(`callback_data "${button.callback_data}" is ${bytes} bytes (1-${CALLBACK_DATA_LIMIT})`);
      } else if (!button.url) {
        problems.push(`row ${r}: button "${button.text}" has neither callback_data nor url`);
      }
    }
  });
  return problems;
}

/** Everything wrong with one outgoing Bot API call. */
export function lintOutgoingCall(method: string, payload: Record<string, unknown>): string[] {
  if (method !== 'sendMessage' && method !== 'editMessageText') return [];
  const problems: string[] = [];
  const text = String(payload.text ?? '');
  if (payload.parse_mode === 'HTML') problems.push(...lintTelegramHtml(text));
  else if (text.length > TEXT_LIMIT) problems.push(`text is ${text.length} chars (limit ${TEXT_LIMIT})`);
  problems.push(...lintInlineKeyboard(payload.reply_markup as Markup | undefined));
  return problems;
}
