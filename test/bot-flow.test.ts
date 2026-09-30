import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/o1/client.js';
import { OWNER, PNG_BYTES, STRANGER, createHarness, type Harness } from './bot-harness.js';
import { AAPL, FACTORY, ROUTER, TOKEN, TOKENS_10K, USDC, WALLET, ZERO, RECIPIENT, addr, configFor, quote } from './fixtures.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
  h.files.set('img1', PNG_BYTES);
});

// A handler that throws is a bug unless the test provoked it on purpose.
afterEach(() => {
  if (!h.allowErrors) expect(h.errors).toEqual([]);
});

/** A launch that was sent earlier and never settled, as left behind by a crash. */
function seedPendingLaunch(hash = `0x${'a1'.repeat(32)}`, status: 'sent' | 'unknown' = 'unknown') {
  mkdirSync(h.dataDir, { recursive: true });
  writeFileSync(
    join(h.dataDir, 'launches.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), kind: 'launch', status, chainId: 8453, name: 'Old Coin', symbol: 'OLD', txHash: hash }) + '\n',
  );
  h.wallet.statuses.set(hash as `0x${string}`, 'pending');
  return hash;
}

/** /launch, then name + symbol + image. */
async function fillBasics() {
  await h.command('launch');
  await h.press('in:name:dash');
  await h.text('Pepe Coin');
  await h.press('in:symbol:dash');
  await h.text('$PEPE');
  await h.press('in:image:dash');
  await h.photo('img1');
}

describe('access control', () => {
  it('rejects strangers, but tells them their ID', async () => {
    await h.command('launch', STRANGER);
    expect(h.sentTexts().at(-1)).toContain('Akses ditolak');
    expect(h.sentTexts().at(-1)).toContain(String(STRANGER));
    expect(h.state(STRANGER).draft).toBeNull();
    expect(h.wallet.sent).toHaveLength(0);
  });

  it('lets anyone read their own ID with /id', async () => {
    await h.command('id', STRANGER);
    expect(h.sentTexts().at(-1)).toContain(`<code>${STRANGER}</code>`);
  });

  it('blocks strangers from pressing buttons', async () => {
    await h.press('go:launch', { userId: STRANGER });
    expect(h.alerts()).toContain('Akses ditolak.');
    expect(h.launcher.isBusy()).toBe(false);
  });

  it('ignores group chats entirely', async () => {
    await h.command('launch', OWNER, 'group');
    expect(h.calls).toHaveLength(0);
  });
});

describe('dashboard and inputs', () => {
  it('opens a panel with the native pair preselected', async () => {
    await h.command('launch');
    const text = h.panelText();
    expect(text).toContain('Draft Launch o1');
    expect(text).toContain('Base');
    expect(text).toContain('Tax');
    expect(text).toContain('ETH');
    for (const data of ['nav:pair', 'in:name:dash', 'in:symbol:dash', 'in:image:dash', 'in:website:dash', 'nav:tax', 'nav:dev', 'nav:review', 'go:reset']) {
      expect(h.hasButton(data), data).toBe(true);
    }
    expect(h.state().draft?.quote?.address).toBe(ZERO);
  });

  it('accepts a name and escapes HTML in the panel', async () => {
    await h.command('launch');
    await h.press('in:name:dash');
    expect(h.panelText()).toContain('nama token');
    expect(h.state().awaiting).toEqual({ field: 'name', back: 'dash' });
    await h.text('Pepe <Coin> & Co');
    expect(h.state().draft?.name).toBe('Pepe <Coin> & Co');
    expect(h.panelText()).toContain('Pepe &lt;Coin&gt; &amp; Co');
    expect(h.called('deleteMessage').length).toBeGreaterThan(0); // the typed message is removed
    expect(h.state().awaiting).toBeNull();
  });

  it('keeps asking after invalid input and shows the reason in the panel', async () => {
    await h.command('launch');
    await h.press('in:symbol:dash');
    await h.text('A B');
    expect(h.panelText()).toContain('❌');
    expect(h.panelText()).toContain('spasi');
    expect(h.state().awaiting?.field).toBe('symbol');
    await h.text('$PePe');
    expect(h.state().draft?.symbol).toBe('PePe');
    expect(h.state().awaiting).toBeNull();
    expect(h.panelText()).toContain('Draft Launch o1');
  });

  it('cancel returns to the dashboard without changing anything', async () => {
    await h.command('launch');
    await h.press('in:name:dash');
    await h.press('cancel:dash');
    expect(h.state().awaiting).toBeNull();
    expect(h.state().draft?.name).toBeNull();
    expect(h.panelText()).toContain('Draft Launch o1');
  });

  it('/cancel does the same', async () => {
    await h.command('launch');
    await h.press('in:name:dash');
    await h.command('cancel');
    expect(h.state().awaiting).toBeNull();
  });

  it('normalises and clears social links', async () => {
    await h.command('launch');
    await h.press('in:website:dash');
    await h.text('pepe.example');
    await h.press('in:x:dash');
    await h.text('@pepe');
    await h.press('in:telegram:dash');
    await h.text('t.me/pepe_chat');
    const draft = h.state().draft!;
    expect([draft.website, draft.x, draft.telegram]).toEqual(['https://pepe.example', 'https://x.com/pepe', 'https://t.me/pepe_chat']);
    expect(h.panelText()).toContain('https://x.com/pepe');

    await h.press('in:website:dash');
    await h.press('clr:website:dash');
    expect(h.state().draft?.website).toBe('');
    await h.press('in:x:dash');
    await h.text('https://evil.example/x');
    expect(h.panelText()).toContain('❌');
    expect(h.state().draft?.x).toBe('https://x.com/pepe'); // unchanged after the invalid attempt
  });

  it('answers unknown text with a hint only when there is no draft', async () => {
    await h.text('halo');
    expect(h.sentTexts().at(-1)).toContain('/launch');
  });

  it('says so when a button belongs to an expired session', async () => {
    await h.press('nav:tax');
    expect(h.alerts().at(-1)).toContain('Sesi kedaluwarsa');
  });

  it('refuses buttons of an outdated panel', async () => {
    await h.command('launch');
    const oldId = h.state().panel!.messageId;
    await h.command('launch'); // moves the panel to the bottom
    expect(h.state().panel!.messageId).not.toBe(oldId);
    await h.press('nav:tax', { messageId: oldId });
    expect(h.alerts().at(-1)).toContain('tidak aktif');
  });
});

describe('image input', () => {
  it('stores a valid image and re-sends the panel below it', async () => {
    await h.command('launch');
    await h.press('in:image:dash');
    const before = h.state().panel!.messageId;
    await h.photo('img1');
    expect(h.state().draft?.image).toMatchObject({ type: 'image/png', bytes: PNG_BYTES.length });
    expect(h.state().panel!.messageId).not.toBe(before);
    expect(h.called('deleteMessage').some((c) => c.payload.message_id === before)).toBe(true);
    expect(h.panelText()).toContain('PNG');
  });

  it('falls back to a smaller photo size when the largest exceeds 2 MB', async () => {
    await h.command('launch');
    await h.press('in:image:dash');
    h.files.set('huge-small', PNG_BYTES); // the harness names the small variant "<id>-small"
    await h.photo('huge', 3_000_000);
    expect(h.state().draft?.image?.type).toBe('image/png');
  });

  it('accepts a document image (lossless, keeps GIF/WEBP intact)', async () => {
    await h.command('launch');
    await h.press('in:image:dash');
    await h.document('img1', 'image/png');
    expect(h.state().draft?.image?.type).toBe('image/png');
  });

  it('rejects oversize, non-image documents, garbage bytes and text', async () => {
    await h.command('launch');
    await h.press('in:image:dash');

    await h.document('img1', 'image/png', 3_000_000);
    expect(h.panelText()).toContain('terlalu besar');

    await h.document('img1', 'video/mp4');
    expect(h.panelText()).toContain('bukan gambar');

    h.files.set('bad', Buffer.from('definitely not an image'));
    await h.photo('bad');
    expect(h.panelText()).toContain('Format gambar tidak didukung');

    await h.text('ini bukan gambar');
    expect(h.panelText()).toContain('Kirim gambar sebagai foto');

    expect(h.state().draft?.image).toBeNull();
    expect(h.state().awaiting?.field).toBe('image'); // still waiting for a real image
  });

  it('reports a failed Telegram download', async () => {
    await h.command('launch');
    await h.press('in:image:dash');
    await h.photo('missing-file');
    expect(h.panelText()).toContain('Gagal mengunduh');
    expect(h.state().awaiting?.field).toBe('image');
  });

  it('ignores photos when no image was requested', async () => {
    await h.command('launch');
    const count = h.calls.length;
    await h.photo('img1');
    expect(h.calls.length).toBe(count);
    expect(h.state().draft?.image).toBeNull();
  });
});

describe('pair (quote token) selection', () => {
  it('lists crypto pairs, switches to stocks and picks one', async () => {
    await h.command('launch');
    await h.press('nav:pair');
    expect(h.hasButton(`pair:pick:${ZERO}`)).toBe(true);
    expect(h.hasButton(`pair:pick:${USDC}`)).toBe(true);
    expect(h.hasButton(`pair:pick:${AAPL}`)).toBe(false);
    expect(h.hasButton('pair:filter:stocks')).toBe(true);

    await h.press('pair:filter:stocks');
    expect(h.hasButton(`pair:pick:${AAPL}`)).toBe(true);
    expect(h.hasButton(`pair:pick:${USDC}`)).toBe(false);

    await h.press(`pair:pick:${AAPL}`);
    expect(h.state().draft?.quote).toMatchObject({ symbol: 'AAPL', route: 'rwa', decimals: 8 });
    expect(h.panelText()).toContain('AAPL (stock)');
  });

  it('searches by symbol', async () => {
    await h.command('launch');
    await h.press('nav:pair');
    await h.press('in:pairSearch:pair');
    await h.text('usd');
    expect(h.hasButton(`pair:pick:${USDC}`)).toBe(true);
    expect(h.hasButton(`pair:pick:${ZERO}`)).toBe(false);
    expect(h.hasButton('pair:clearq')).toBe(true);
    await h.press('pair:clearq');
    expect(h.hasButton(`pair:pick:${ZERO}`)).toBe(true);
  });

  it('resets a dev buy amount when the pair (and its decimals) change', async () => {
    await h.command('launch');
    await h.press('nav:dev');
    await h.press('tog:dev');
    await h.press('in:devAmount:dev');
    await h.text('0.05');
    expect(h.state().draft?.devBuy.amountRaw).toBe('50000000000000000');
    await h.press('nav:pair');
    await h.press(`pair:pick:${USDC}`);
    expect(h.state().draft?.devBuy.amountRaw).toBeNull();
  });

  it('paginates long lists (Robinhood has ~190 stocks)', async () => {
    const cfg = h.api.configs.tax!;
    const suiteId = cfg.suites![0]!.id;
    for (let i = 0; i < 20; i++) {
      cfg.quotes!.push({ address: `0x${(0x9000 + i).toString(16).padStart(40, '0')}`, symbol: `S${i}`, decimals: 18, route: 'rwa', suite_id: suiteId, registered: true, selectable: true, asset_type: 'tokenized_security' });
    }
    await h.command('launch');
    await h.press('nav:pair');
    await h.press('pair:filter:stocks');
    expect(h.panelText()).toContain('Halaman 1/3');
    expect(h.hasButton('pair:page:1')).toBe(true);
    await h.press('pair:page:1');
    expect(h.panelText()).toContain('Halaman 2/3');
    expect(h.hasButton('pair:page:0')).toBe(true);
  });
});

describe('chain and product', () => {
  it('toggles Standard, hiding the tax controls and reloading pairs for that product', async () => {
    await h.command('launch');
    const before = h.api.configCalls;
    await h.press('prod:toggle');
    expect(h.state().draft?.product).toBe('non-tax');
    expect(h.hasButton('nav:tax')).toBe(false);
    expect(h.api.configCalls).toBeGreaterThan(before);
    expect(h.state().draft?.quote?.symbol).toBe('ETH');
    await h.press('prod:toggle');
    expect(h.state().draft?.product).toBe('tax');
    expect(h.hasButton('nav:tax')).toBe(true);
  });

  it('only offers chains the wallet has a verified RPC for', async () => {
    await h.command('launch');
    await h.press('nav:chain');
    expect(h.hasButton('chain:8453')).toBe(true);
    expect(h.hasButton('chain:56')).toBe(false);
    await h.press('chain:56');
    expect(h.alerts().at(-1)).toBe('Chain tidak aktif.');
    await h.press('chain:8453');
    expect(h.panelText()).toContain('Draft Launch o1');
  });
});

describe('tax settings', () => {
  beforeEach(async () => {
    await h.command('launch');
    await h.press('nav:tax');
  });

  it('shows the policy and the per-trade split', () => {
    const text = h.panelText();
    expect(text).toContain('Pengaturan Tax');
    expect(text).toContain('buy 1–10%');
    expect(text).toContain('protocol 0.5%');
  });

  it('applies quick presets to both sides', async () => {
    await h.press('pre:tax:5');
    expect(h.state().draft?.tax).toMatchObject({ buyRate: '5000000', sellRate: '5000000' });
    expect(h.panelText()).toContain('Buy 5% · Sell 5%');
  });

  it('validates typed rates against the chain policy', async () => {
    await h.press('in:buyTax:tax');
    await h.text('11');
    expect(h.panelText()).toContain('harus antara 1% dan 10%');
    expect(h.state().awaiting?.field).toBe('buyTax');
    await h.text('4');
    expect(h.state().draft?.tax.buyRate).toBe('4000000');
    expect(h.panelText()).toContain('Pengaturan Tax'); // returned to the tax view
    await h.press('in:sellTax:tax');
    await h.text('2,5');
    expect(h.state().draft?.tax.sellRate).toBe('2500000');
  });

  it('splits the remainder and manages the dividend holding threshold', async () => {
    expect(h.hasButton('in:minHolding:tax')).toBe(false); // no dividends by default
    await h.press('pre:split:1'); // 50/50/0
    const tax = h.state().draft!.tax;
    expect([tax.creatorShare, tax.dividendShare, tax.burnShare]).toEqual(['50000000', '50000000', '0']);
    expect(tax.minHolding).toBe(TOKENS_10K); // floor applied automatically
    expect(h.hasButton('in:minHolding:tax')).toBe(true);

    await h.press('pre:hold:100000');
    expect(h.state().draft?.tax.minHolding).toBe('100000000000000000000000');
    await h.press('in:minHolding:tax');
    await h.text('5');
    expect(h.panelText()).toContain('Minimal 10,000 token');
    await h.text('2.5m');
    expect(h.state().draft?.tax.minHolding).toBe('2500000000000000000000000');

    await h.press('pre:split:0'); // 100/0/0 -> dividends off again
    expect(h.state().draft?.tax.minHolding).toBe('0');
    expect(h.hasButton('in:minHolding:tax')).toBe(false);
  });

  it('accepts a custom split only when it adds up to 100', async () => {
    await h.press('in:split:tax');
    await h.text('70/20/20');
    expect(h.panelText()).toContain('Total harus 100%');
    await h.text('70/20/10');
    const tax = h.state().draft!.tax;
    expect([tax.creatorShare, tax.dividendShare, tax.burnShare]).toEqual(['70000000', '20000000', '10000000']);
  });

  it('toggles anti-snipe and sets the fee recipient', async () => {
    await h.press('tog:anti');
    expect(h.state().draft?.tax.antiSnipe).toBe(false);
    await h.press('in:recipient:tax');
    await h.text('0x123');
    expect(h.panelText()).toContain('Alamat wallet tidak valid');
    await h.text(RECIPIENT);
    expect(h.state().draft?.tax.creatorRecipient).toBe(RECIPIENT);
    await h.press('pre:self');
    expect(h.state().draft?.tax.creatorRecipient).toBe(WALLET);
  });
});

describe('dev buy settings', () => {
  beforeEach(async () => {
    await h.command('launch');
    await h.press('nav:dev');
  });

  it('explains that it is not atomic', () => {
    expect(h.panelText()).toContain('bukan atomic');
    expect(h.panelText()).toContain('anti-snipe');
  });

  it('enables, sets amount, slippage and timing', async () => {
    await h.press('tog:dev');
    expect(h.state().draft?.devBuy.enabled).toBe(true);
    await h.press('in:devAmount:dev');
    await h.text('abc');
    expect(h.panelText()).toContain('❌');
    await h.text('0,05');
    expect(h.state().draft?.devBuy.amountRaw).toBe('50000000000000000');
    expect(h.panelText()).toContain('0.05 ETH');
    await h.press('pre:slip:1000');
    expect(h.state().draft?.devBuy.slippageBps).toBe(1000);
    await h.press('in:devSlippage:dev');
    await h.text('60');
    expect(h.panelText()).toContain('antara 0.01% dan 49.99%');
    await h.text('2.5');
    expect(h.state().draft?.devBuy.slippageBps).toBe(250);
    await h.press('tog:timing');
    expect(h.state().draft?.devBuy.timing).toBe('now');
    expect(h.panelText()).toContain('segera');
  });

  it('will not enable dev buy without a pair', async () => {
    h.state().draft!.quote = null;
    await h.press('tog:dev');
    expect(h.alerts().at(-1)).toBe('Pilih pair dulu.');
    expect(h.state().draft?.devBuy.enabled).toBe(false);
  });
});

describe('review', () => {
  it('lists what is missing and offers no launch button', async () => {
    await h.command('launch');
    await h.press('nav:review');
    const text = h.panelText();
    expect(text).toContain('Belum bisa launch');
    expect(text).toContain('Nama belum diisi');
    expect(text).toContain('Gambar belum diisi');
    expect(h.hasButton('go:launch')).toBe(false);
  });

  it('passes for a complete draft and remembers the reviewed fee', async () => {
    await fillBasics();
    await h.press('nav:review');
    expect(h.panelText()).toContain('Semua cek lolos');
    expect(h.panelText()).toContain('Creation fee: 0.001 ETH');
    expect(h.hasButton('go:launch')).toBe(true);
    expect(h.state().reviewed?.fee).toEqual({ currency: ZERO, amountRaw: 1_000_000_000_000_000n });
  });

  it('blocks on insufficient balance', async () => {
    await fillBasics();
    h.wallet.balance = 0n;
    await h.press('nav:review');
    expect(h.panelText()).toContain('Saldo ETH kurang');
    expect(h.hasButton('go:launch')).toBe(false);
  });

  it('counts a native dev buy on top of the fee', async () => {
    await fillBasics();
    await h.press('nav:dev');
    await h.press('tog:dev');
    await h.press('in:devAmount:dev');
    await h.text('0.5');
    h.wallet.balance = 400_000_000_000_000_000n; // 0.4 ETH < 0.5 + 0.001
    await h.press('nav:review');
    expect(h.panelText()).toContain('Saldo ETH kurang');
  });

  it('requires an amount when dev buy is on', async () => {
    await fillBasics();
    await h.press('nav:dev');
    await h.press('tog:dev');
    await h.press('nav:review');
    expect(h.panelText()).toContain('Jumlah dev buy belum diisi');
  });

  it('shows the o1 contracts that will receive the money, and the router only when a dev buy is planned', async () => {
    await fillBasics();
    await h.press('nav:review');
    expect(h.panelText()).toContain('Kontrak o1 yang menerima dana');
    expect(h.panelText()).toContain(FACTORY);
    expect(h.panelText()).not.toContain(ROUTER);
    expect(h.state().reviewed?.contracts).toMatchObject({ factory: FACTORY.toLowerCase(), swapRouter: ROUTER.toLowerCase() });

    await h.press('nav:dev');
    await h.press('tog:dev');
    await h.press('in:devAmount:dev');
    await h.text('0.05');
    await h.press('nav:review');
    expect(h.panelText()).toContain(`Router swap: <code>${ROUTER}</code>`);
  });

  it('refuses a green light when the history cannot be read', async () => {
    mkdirSync(join(h.dataDir, 'launches.jsonl'), { recursive: true }); // EISDIR, not "no history"
    await fillBasics();
    await h.press('nav:review');
    expect(h.panelText()).toContain('Riwayat launch tidak bisa dibaca');
    expect(h.hasButton('go:launch')).toBe(false);
    expect(h.state().reviewed).toBeNull();
  });

  it('blocks while an earlier launch is still unresolved', async () => {
    seedPendingLaunch();
    await fillBasics();
    await h.press('nav:review');
    expect(h.panelText()).toContain('Ada launch sebelumnya yang hasilnya belum jelas');
    expect(h.panelText()).toContain('/dismiss ya');
    expect(h.hasButton('go:launch')).toBe(false);
    expect(h.state().reviewed).toBeNull();
  });

  it('checks the balance of an ERC-20 creation fee, and remembers its currency', async () => {
    const cfg = configFor('tax');
    cfg.suites![0]!.creation_fee = { amount_raw: '5000000', currency: USDC, symbol: 'USDC', decimals: 6 };
    h.api.configs.tax = cfg;
    await fillBasics();
    h.wallet.quoteBalance = 4_000_000n;
    await h.press('nav:review');
    expect(h.panelText()).toContain('Saldo USDC kurang');
    expect(h.hasButton('go:launch')).toBe(false);

    h.wallet.quoteBalance = 6_000_000n;
    await h.press('nav:review');
    expect(h.panelText()).toContain('Creation fee: 5 USDC');
    expect(h.panelText()).toContain('Saldo USDC: 6 (butuh 5)');
    expect(h.hasButton('go:launch')).toBe(true);
    expect(h.state().reviewed?.fee).toEqual({ currency: USDC, amountRaw: 5_000_000n });
  });

  it('a review only counts for the draft it was made for', async () => {
    await fillBasics();
    await h.press('nav:review');
    expect(h.state().reviewed).not.toBeNull();

    h.state().draft!.name = 'Something Else'; // edited after the review
    await h.press('go:launch');
    expect(h.alerts().at(-1)).toContain('Draft berubah sejak Review');
    expect(h.wallet.sent).toHaveLength(0);
    expect(h.state().reviewed).toBeNull();
    expect(h.launcher.isBusy()).toBe(false);
  });

  describe('the review is invalidated by ANY change that reaches the launch (round-2 review)', () => {
    const edits: Array<[string, (d: NonNullable<ReturnType<typeof h.state>['draft']>) => void]> = [
      ['name', (d) => void (d.name = 'Other')],
      ['symbol', (d) => void (d.symbol = 'OTHER')],
      ['description', (d) => void (d.description = 'changed')],
      ['website', (d) => void (d.website = 'https://other.example')],
      ['x', (d) => void (d.x = 'https://x.com/other')],
      ['telegram', (d) => void (d.telegram = 'https://t.me/other')],
      ['image bytes', (d) => void (d.image = { ...d.image!, base64: Buffer.from('different image bytes').toString('base64') })],
      ['image type', (d) => void (d.image = { ...d.image!, type: 'image/jpeg' })],
      ['buy tax', (d) => void (d.tax.buyRate = '2000000')],
      ['sell tax', (d) => void (d.tax.sellRate = '2000000')],
      ['tax split', (d) => void (d.tax.creatorShare = '50000000')],
      ['tax recipient', (d) => void (d.tax.creatorRecipient = addr(0x7777))],
      ['anti-snipe', (d) => void (d.tax.antiSnipe = !d.tax.antiSnipe)],
      ['dev buy on', (d) => void (d.devBuy.enabled = true)],
      ['dev buy amount', (d) => void (d.devBuy.amountRaw = '123')],
      ['dev buy slippage', (d) => void (d.devBuy.slippageBps = 999)],
      ['dev buy timing', (d) => void (d.devBuy.timing = 'now')],
      ['pair', (d) => void (d.quote = { ...d.quote!, address: USDC, symbol: 'USDC' })],
      ['chain', (d) => void (d.chainId = 56)],
      ['product', (d) => void (d.product = 'non-tax')],
      ['editable profile', (d) => void (d.editableMetadata = !d.editableMetadata)],
    ];

    it.each(edits)('%s', async (_name, change) => {
      await fillBasics();
      await h.press('nav:review');
      expect(h.state().reviewed).not.toBeNull();
      change(h.state().draft!);
      await h.press('go:launch');
      expect(h.alerts().at(-1)).toContain('Draft berubah sejak Review');
      expect(h.wallet.broadcasts).toHaveLength(0);
    });

    it('but the same draft reviewed twice launches', async () => {
      await fillBasics();
      await h.press('nav:review');
      await h.press('nav:dash');
      await h.press('nav:review');
      await h.press('go:launch');
      await h.settled();
      expect(h.wallet.sent).toHaveLength(1);
    });
  });

  it('escapes hostile pair symbols in every view that shows them', async () => {
    const cfg = configFor('tax');
    const hostile = addr(0x9009);
    cfg.quotes!.push(quote(cfg.suites![0]!.id, hostile, '<i>&EVIL', { asset_type: 'crypto_token', name: '<b>Evil' }));
    h.api.configs.tax = cfg;
    await fillBasics();
    await h.press('nav:pair');
    await h.press(`pair:pick:${hostile}`);
    await h.press('nav:dev');
    await h.press('tog:dev');
    await h.press('in:devAmount:dev');
    await h.text('1');
    expect(h.panelText()).toContain('&lt;i&gt;&amp;EVIL');
    await h.press('nav:review'); // the harness lints every outgoing message: an unescaped symbol would fail the test
    expect(h.panelText()).toContain('&lt;i&gt;&amp;EVIL');
  });

  it('flags an invalid tax setup coming from the chain policy', async () => {
    await fillBasics();
    h.state().draft!.tax.buyRate = '50000000';
    await h.press('nav:review');
    expect(h.panelText()).toContain('Buy tax harus antara');
  });
});

describe('launching', () => {
  it('launches, reports the result, and keeps reusable settings for the next draft', async () => {
    await fillBasics();
    await h.press('nav:tax');
    await h.press('pre:tax:5');
    await h.press('nav:review');
    await h.press('go:launch');
    await h.settled();

    // sent exactly one transaction, built from the draft
    expect(h.wallet.sent).toHaveLength(1);
    const body = h.api.prepareCalls[0]!.body;
    expect(body.token).toMatchObject({ name: 'Pepe Coin', symbol: 'PEPE', image_type: 'image/png' });
    expect(body.tax).toMatchObject({ buy_tax_rate: '5000000', sell_tax_rate: '5000000' });

    const text = h.panelText();
    expect(text).toContain('Launch berhasil');
    expect(text).toContain(TOKEN);
    expect(text).toContain('Pepe Coin');
    expect(h.hasButton('go:again')).toBe(true);

    const st = h.state();
    expect(st.launching).toBe(false);
    expect(st.draft).toBeNull();
    expect(st.panel).toBeNull();
    expect(st.lastDraft?.name).toBe('Pepe Coin');

    // "Launch lagi" carries settings over but not the token identity
    await h.press('go:again');
    const next = h.state().draft!;
    expect(next.name).toBeNull();
    expect(next.symbol).toBeNull();
    expect(next.image).toBeNull();
    expect(next.tax.buyRate).toBe('5000000');
    expect(next.quote?.symbol).toBe('ETH');
    expect(h.panelText()).toContain('Draft Launch o1');
  });

  it('shows progress while the launch runs and never blocks the update handler', async () => {
    await fillBasics();
    await h.press('nav:review');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = h.api.prepareLaunch.bind(h.api);
    h.api.prepareLaunch = async (body, key) => {
      await gate;
      return original(body, key);
    };

    await h.press('go:launch'); // returns immediately although the launch is pending
    expect(h.state().launching).toBe(true);
    expect(h.panelText()).toContain('Sedang launch');

    // while it runs: buttons are locked, a second launch is refused, /launch is refused
    await h.press('nav:tax');
    expect(h.alerts().at(-1)).toBe('Launch sedang berjalan…');
    await h.press('go:launch');
    expect(h.alerts().at(-1)).toBe('Launch sedang berjalan…');
    await h.command('launch');
    expect(h.sentTexts().at(-1)).toContain('Masih ada launch');

    release();
    await h.settled();
    expect(h.wallet.sent).toHaveLength(1);
    expect(h.panelText()).toContain('Launch berhasil');
  });

  it('runs the dev buy after the launch and reports it', async () => {
    h.api.swapPrepareImpl = async () => ({
      steps: [
        {
          id: 'swap', kind: 'transaction', label: 'Swap', depends_on: [],
          transaction: { chain_id: 8453, from: WALLET, to: ROUTER, data: '0xfeed', value: '50000000000000000' },
          simulation: { status: 'succeeded' },
        },
      ],
    });
    await fillBasics();
    await h.press('nav:dev');
    await h.press('tog:dev');
    await h.press('in:devAmount:dev');
    await h.text('0.05');
    await h.press('nav:review');
    await h.press('go:launch');
    await h.settled();

    expect(h.wallet.sent).toHaveLength(2);
    expect(h.panelText()).toContain('Dev buy: ✅ 0.05 ETH');
    expect(h.api.quoteCalls[0]).toMatchObject({ side: 'buy', amount_in_raw: '50000000000000000', slippage_bps: 500 });
  });

  it('reports a failed dev buy without calling the launch a failure', async () => {
    h.api.quoteImpl = async () => {
      throw new ApiError(422, 'simulation_failed', 'router reverted', { status: 422, code: 'simulation_failed', detail: 'router reverted' });
    };
    await fillBasics();
    await h.press('nav:dev');
    await h.press('tog:dev');
    await h.press('in:devAmount:dev');
    await h.text('0.05');
    await h.press('nav:review');
    await h.press('go:launch');
    await h.settled();

    const text = h.panelText();
    expect(text).toContain('Launch berhasil');
    expect(text).toContain('Dev buy: ⚠️ gagal');
    expect(text).toContain('router reverted');
  });

  it('reports a failed launch, keeps the draft and lets the user go back', async () => {
    h.api.planFactory = () => {
      throw new ApiError(422, 'insufficient_balance', 'no funds', {
        status: 422, code: 'insufficient_balance', asset: ZERO, actual_raw: '1000', required_raw: '2000000000000000',
      });
    };
    await fillBasics();
    await h.press('nav:review');
    await h.press('go:launch');
    await h.settled();

    expect(h.panelText()).toContain('Launch gagal');
    expect(h.panelText()).toContain('Saldo kurang');
    expect(h.hasButton('nav:dash')).toBe(true);
    expect(h.state().draft?.name).toBe('Pepe Coin'); // draft survives
    expect(h.state().launching).toBe(false);
    expect(h.wallet.sent).toHaveLength(0);

    await h.press('nav:dash');
    expect(h.panelText()).toContain('Draft Launch o1');
  });

  it('shows the hash and explorer link of a reverted launch', async () => {
    h.wallet.receipts = ['reverted'];
    await fillBasics();
    await h.press('nav:review');
    await h.press('go:launch');
    await h.settled();
    expect(h.panelText()).toContain('Launch gagal');
    expect(h.panelText()).toContain(h.wallet.sent[0]!.hash);
    expect(h.panelText()).toContain('https://basescan.org/tx/');
  });

  it('needs a fresh review after every attempt, successful or not', async () => {
    h.wallet.receipts = ['reverted'];
    await fillBasics();
    await h.press('nav:review');
    await h.press('go:launch');
    await h.settled();
    expect(h.panelText()).toContain('Launch gagal');
    expect(h.state().reviewed).toBeNull();
    await h.press('go:launch');
    expect(h.alerts().at(-1)).toContain('Review');
    expect(h.wallet.broadcasts).toHaveLength(1);
  });

  it('an unconfirmed launch is reported as unclear (not as a failure), blocks the next one and points to /dismiss', async () => {
    h.wallet.receipts = ['timeout'];
    await fillBasics();
    await h.press('nav:review');
    await h.press('go:launch');
    await h.settled();
    expect(h.panelText()).toContain('Hasil launch belum jelas');
    expect(h.panelText()).toContain('Jangan launch ulang');
    expect(h.panelText()).not.toContain('Draft-mu masih tersimpan'); // that line invited exactly the wrong thing
    const hash = h.wallet.sent[0]!.hash;
    expect(h.panelText()).toContain(hash);
    h.wallet.statuses.set(hash, 'pending');

    await h.press('nav:dash');
    await h.press('nav:review');
    expect(h.panelText()).toContain('Ada launch sebelumnya yang hasilnya belum jelas');
    expect(h.hasButton('go:launch')).toBe(false);
  });

  it('a launch that confirmed after the "unclear" report cannot be launched again with the same draft (relaunch trap)', async () => {
    h.wallet.receipts = ['timeout'];
    await fillBasics();
    await h.press('nav:review');
    await h.press('go:launch');
    await h.settled();
    const hash = h.wallet.sent[0]!.hash;

    // it mines a little later, and the bot notices silently
    h.wallet.statuses.set(hash, 'success');
    await h.press('nav:dash');
    await h.press('nav:review');
    expect(h.panelText()).toContain('Draft ini sudah berhasil di-launch');
    expect(h.panelText()).toContain('token kembar');
    expect(h.hasButton('go:launch')).toBe(false);
    expect(h.state().reviewed).toBeNull();

    await h.press('go:launch'); // even a stale or forged button changes nothing
    expect(h.alerts().at(-1)).toContain('Review');
    expect(h.wallet.broadcasts).toHaveLength(1);

    // a fresh draft is the owner's explicit choice
    await h.press('go:reset');
    expect(h.state().draft?.name).toBeNull();
  });

  it('aborts, and asks for a new review, when the o1 contracts change between review and launch', async () => {
    await fillBasics();
    await h.press('nav:review');
    const cfg = configFor('tax');
    cfg.suites![0]!.contracts.factory = addr(0x9999);
    h.api.configs.tax = cfg;
    await h.press('go:launch');
    await h.settled();
    expect(h.panelText()).toContain('Launch gagal');
    expect(h.panelText()).toContain('Alamat kontrak o1 berubah sejak Review');
    expect(h.wallet.broadcasts).toHaveLength(0);
    expect(h.state().reviewed).toBeNull();
  });

  it('reports a dev buy whose swap may still land as unclear, and does not tell the owner to buy by hand', async () => {
    h.api.swapPrepareImpl = async () => ({
      steps: [
        {
          id: 'swap', kind: 'transaction', label: 'Swap', depends_on: [],
          transaction: { chain_id: 8453, from: WALLET, to: ROUTER, data: '0xfeed', value: '50000000000000000' },
          simulation: { status: 'succeeded' },
        },
      ],
    });
    h.wallet.broadcastBehaviors = ['ok', 'uncertain-lost'];
    await fillBasics();
    await h.press('nav:dev');
    await h.press('tog:dev');
    await h.press('in:devAmount:dev');
    await h.text('0.05');
    await h.press('nav:review');
    await h.press('go:launch');
    await h.settled();
    const text = h.panelText();
    expect(text).toContain('Launch berhasil');
    expect(text).toContain('hasilnya belum jelas');
    expect(text).toContain('SEBELUM membeli manual');
    expect(text).not.toContain('Kamu bisa beli manual');
  });

  it('will not launch before the review, or when the draft became invalid', async () => {
    await fillBasics();
    await h.press('go:launch'); // from the dashboard, not the review panel
    expect(h.alerts().at(-1)).toContain('Review');
    expect(h.wallet.sent).toHaveLength(0);
  });
});

describe('strangers cannot slow the owner down (round-2 review)', () => {
  const rejections = () => h.sentTexts().filter((t) => t.includes('Akses ditolak'));

  it('a stranger is told once a minute at most, however much they send', async () => {
    for (let i = 0; i < 6; i++) await h.command('launch', STRANGER);
    await h.press('go:launch', { userId: STRANGER });
    expect(rejections()).toHaveLength(1);
    expect(h.alerts()).toHaveLength(0); // ... and the button press was ignored quietly
    await h.command('launch', 8); // another stranger has their own allowance
    expect(rejections()).toHaveLength(2);
  });

  it('a reply to a stranger that hangs (flood control) never holds up the owner', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.bot.api.config.use(async (prev, method, payload) => {
      if (method === 'sendMessage' && (payload as { chat_id: number }).chat_id === STRANGER) await gate;
      return prev(method, payload);
    });
    await h.command('launch', STRANGER); // returns although Telegram is "busy" with the reply
    await h.command('launch');
    expect(h.panelText()).toContain('Draft Launch o1');
    release();
  });
});

describe('other commands', () => {
  it('/wallet shows the address and balances', async () => {
    await h.command('wallet');
    const text = h.sentTexts().at(-1)!;
    expect(text).toContain(WALLET);
    expect(text).toContain('Base: 1 ETH');
  });

  it('/history is empty at first and lists launches afterwards', async () => {
    await h.command('history');
    expect(h.sentTexts().at(-1)).toContain('Belum ada launch');
    await fillBasics();
    await h.press('nav:review');
    await h.press('go:launch');
    await h.settled();
    await h.command('history');
    const text = h.sentTexts().at(-1)!;
    expect(text).toContain('Pepe Coin');
    expect(text).toContain(TOKEN);
  });

  describe('/dismiss', () => {
    it('says so when nothing is pending', async () => {
      await h.command('dismiss');
      expect(h.sentTexts().at(-1)).toContain('Tidak ada launch yang tertunda');
    });

    it('lists the pending launch first, and only forgets it after an explicit "ya"', async () => {
      const hash = seedPendingLaunch();
      await h.command('dismiss');
      let text = h.sentTexts().at(-1)!;
      expect(text).toContain('Launch tertunda');
      expect(text).toContain('Old Coin');
      expect(text).toContain(`https://basescan.org/tx/${hash}`);
      expect(text).toContain('/dismiss ya');
      expect((await h.launcher.pendingLaunches()).length).toBe(1);

      await h.command('dismiss', OWNER, 'private', 'tidak');
      expect((await h.launcher.pendingLaunches()).length).toBe(1);

      await h.command('dismiss', OWNER, 'private', 'ya');
      text = h.sentTexts().at(-1)!;
      expect(text).toContain('Diabaikan: 1');
      expect(await h.launcher.pendingLaunches()).toEqual([]);

      await fillBasics();
      await h.press('nav:review');
      expect(h.hasButton('go:launch')).toBe(true);
    });

    it('is refused while a launch is running', async () => {
      await fillBasics();
      await h.press('nav:review');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const original = h.api.prepareLaunch.bind(h.api);
      h.api.prepareLaunch = async (body, key) => {
        await gate;
        return original(body, key);
      };
      await h.press('go:launch');
      await h.command('dismiss', OWNER, 'private', 'ya');
      expect(h.sentTexts().at(-1)).toContain('Launch sedang berjalan');
      release();
      await h.settled();
    });

    it('is not available to strangers', async () => {
      seedPendingLaunch();
      await h.command('dismiss', STRANGER, 'private', 'ya');
      expect(h.sentTexts().at(-1)).toContain('Akses ditolak');
      expect((await h.launcher.pendingLaunches()).length).toBe(1);
    });
  });

  it('/start explains the bot without leaking secrets', async () => {
    await h.command('start');
    const text = h.sentTexts().at(-1)!;
    expect(text).toContain('/launch');
    expect(text).not.toContain(h.config.privateKey);
    expect(text).not.toContain(h.config.o1ApiKey);
  });

  it('go:reset starts over without carrying anything', async () => {
    await fillBasics();
    await h.press('go:reset');
    expect(h.state().draft?.name).toBeNull();
    expect(h.state().draft?.image).toBeNull();
  });
});

describe('Telegram failures', () => {
  it('does not turn a rate limit into a stream of new panels', async () => {
    await h.command('launch');
    const panel = h.state().panel!.messageId;
    const sends = h.called('sendMessage').length;
    h.allowErrors = true; // the rate limit surfaces to bot.catch(), which tells the user once
    h.faults.editMessageText = { error_code: 429, description: 'Too Many Requests: retry after 5' };
    await h.press('nav:tax');
    expect(h.errors).toHaveLength(1);
    // no replacement dashboard/tax panel was sent; only the generic error notice at most
    const newSends = h.called('sendMessage').slice(sends).map((c) => String(c.payload.text));
    expect(newSends.every((t) => t.includes('kesalahan internal'))).toBe(true);
    expect(h.state().panel!.messageId).toBe(panel);
  });

  it('sends a fresh panel when the old message was deleted', async () => {
    await h.command('launch');
    const old = h.state().panel!.messageId;
    h.faults.editMessageText = { error_code: 400, description: 'Bad Request: message to edit not found' };
    await h.press('nav:tax');
    expect(h.state().panel!.messageId).not.toBe(old);
    expect(h.panelText()).toContain('Pengaturan Tax');
  });

  it('ignores "message is not modified"', async () => {
    await h.command('launch');
    const panel = h.state().panel!.messageId;
    h.faults.editMessageText = { error_code: 400, description: 'Bad Request: message is not modified' };
    await h.press('nav:dash');
    expect(h.state().panel!.messageId).toBe(panel);
    expect(h.called('sendMessage')).toHaveLength(1); // only the original panel
  });

  it('still tells the user the token address when the result message cannot be edited', async () => {
    await fillBasics();
    await h.press('nav:review');
    h.faults.editMessageText = { error_code: 429, description: 'Too Many Requests: retry after 5' };
    await h.press('go:launch');
    await h.settled();
    expect(h.wallet.sent).toHaveLength(1); // the launch itself is unaffected
    expect(h.sentTexts().some((t) => t.includes('Launch berhasil') && t.includes(TOKEN))).toBe(true);
  });
});
