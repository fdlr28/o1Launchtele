import { describe, expect, it } from 'vitest';
import { lintInlineKeyboard, lintOutgoingCall, lintTelegramHtml } from './telegram-lint.js';

describe('lintTelegramHtml', () => {
  it('accepts valid Telegram HTML', () => {
    expect(lintTelegramHtml('<b>Halo</b> &amp; <i>dunia</i> <code>0x1</code> <a href="https://x.test/a?b=1&amp;c=2">tx</a>')).toEqual([]);
    expect(lintTelegramHtml('<b>a <i>b</i></b>')).toEqual([]);
  });

  it('detects the mistakes that make Telegram reject a message', () => {
    expect(lintTelegramHtml('<b>oops')).toEqual(['unclosed tags: b']);
    expect(lintTelegramHtml('<b>x</i>').join()).toMatch(/mismatched/);
    expect(lintTelegramHtml('a < b').join()).toMatch(/unescaped/);
    expect(lintTelegramHtml('Tom & Jerry').join()).toMatch(/unescaped &/);
    expect(lintTelegramHtml('<div>x</div>').join()).toMatch(/unsupported tag/);
    expect(lintTelegramHtml('<a>x</a>').join()).toMatch(/href/);
    expect(lintTelegramHtml('x'.repeat(4097)).join()).toMatch(/limit 4096/);
    expect(lintTelegramHtml('').join()).toMatch(/empty/);
  });
});

describe('lintInlineKeyboard', () => {
  it('accepts a normal keyboard', () => {
    expect(lintInlineKeyboard({ inline_keyboard: [[{ text: 'ok', callback_data: 'nav:dash' }]] })).toEqual([]);
  });

  it('detects oversize callback data, empty labels and buttons without an action', () => {
    expect(lintInlineKeyboard({ inline_keyboard: [[{ text: 'x', callback_data: 'a'.repeat(65) }]] }).join()).toMatch(/65 bytes/);
    expect(lintInlineKeyboard({ inline_keyboard: [[{ text: ' ', callback_data: 'a' }]] }).join()).toMatch(/empty label/);
    expect(lintInlineKeyboard({ inline_keyboard: [[{ text: 'x' }]] }).join()).toMatch(/neither/);
    expect(lintInlineKeyboard({ inline_keyboard: [Array.from({ length: 9 }, () => ({ text: 'x', callback_data: 'a' }))] }).join()).toMatch(/limit 8/);
  });
});

describe('lintOutgoingCall', () => {
  it('only inspects message sends and edits', () => {
    expect(lintOutgoingCall('answerCallbackQuery', { text: '<' })).toEqual([]);
    expect(lintOutgoingCall('sendMessage', { text: '<b>x', parse_mode: 'HTML' })).not.toEqual([]);
    expect(lintOutgoingCall('sendMessage', { text: '<b>plain text is fine' })).toEqual([]);
  });
});
