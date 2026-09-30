import type { Bot } from 'grammy';
import { CHAINS } from '../chains.js';
import { formatAmount } from '../domain/units.js';
import { describeError } from '../errors.js';
import { code, esc, link, shortAddress } from './format.js';
import { openLaunchPanel } from './callbacks.js';
import { Ui, targetOf, type BotDeps } from './panel.js';
import type { BotContext } from './state.js';

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

export const COMMAND_LIST = [
  { command: 'launch', description: 'Buat / lanjutkan draft launch' },
  { command: 'wallet', description: 'Alamat & saldo wallet launcher' },
  { command: 'history', description: 'Launch terakhir' },
  { command: 'dismiss', description: 'Abaikan launch tertunda yang hasilnya tak jelas' },
  { command: 'cancel', description: 'Batalkan input yang sedang berjalan' },
  { command: 'help', description: 'Bantuan' },
  { command: 'id', description: 'Lihat Telegram ID kamu' },
];

const HELP = [
  '<b>o1 Launch Bot</b> — launch token di o1 Launchpad langsung dari Telegram.',
  '',
  '/launch — buat draft launch (chain, pair, nama, simbol, gambar, sosial, tax, dev buy)',
  '/wallet — alamat &amp; saldo wallet launcher',
  '/history — launch terakhir',
  '/dismiss — abaikan launch tertunda (hasilnya belum jelas) setelah kamu memeriksanya di explorer',
  '/cancel — batalkan input yang sedang berjalan',
  '/id — lihat Telegram ID kamu',
  '',
  '<b>Alur:</b> /launch → isi field lewat tombol → <b>Review &amp; Launch</b> → konfirmasi.',
  'Bot menandatangani transaksi dengan wallet launcher; pastikan wallet itu berisi dana untuk creation fee dan gas.',
].join('\n');

export function registerCommands(bot: Bot<BotContext>, deps: BotDeps, ui: Ui): void {
  bot.command(['start', 'help'], async (ctx) => {
    const chains = ui.supportedChains().map((id) => ui.chainName(id)).join(', ') || '—';
    await ctx.reply(`${HELP}\n\n👛 Wallet: ${code(deps.wallet.address)}\n⛓ Chain aktif: ${esc(chains)}`, HTML);
  });

  bot.command('launch', (ctx) => openLaunchPanel(ctx, deps, ui, 'auto'));

  bot.command('cancel', async (ctx) => {
    const st = ctx.state;
    if (st.launching) return void (await ctx.reply('⏳ Launch sedang berjalan dan tidak bisa dibatalkan dari sini.'));
    if (!st.awaiting) return void (await ctx.reply('Tidak ada input yang sedang berjalan.'));
    const back = st.awaiting.back;
    st.awaiting = null;
    if (st.draft) await ui.show(targetOf(ctx), back);
    else await ctx.reply('Dibatalkan.');
  });

  bot.command('dismiss', async (ctx) => {
    if (ctx.state.launching || deps.launcher.isBusy()) return void (await ctx.reply('⏳ Launch sedang berjalan. Coba lagi setelah selesai.'));
    let pending;
    try {
      pending = await deps.launcher.pendingLaunches();
    } catch (err) {
      return void (await ctx.reply(`Gagal memeriksa riwayat: ${describeError(err)}`));
    }
    if (pending.length === 0) return void (await ctx.reply('✅ Tidak ada launch yang tertunda.'));

    if (ctx.match.trim().toLowerCase() !== 'ya') {
      const lines = ['⚠️ <b>Launch tertunda</b>', 'Transaksi ini terkirim tetapi hasilnya belum jelas. Periksa di explorer:', ''];
      for (const row of pending) {
        const explorer = ui.explorer(row.chainId);
        const url = row.txHash ? explorer('tx', row.txHash) : null;
        const label = row.txHash ? shortAddress(row.txHash) : '?';
        lines.push(`• <b>${esc(row.name ?? '?')}</b> ($${esc(row.symbol ?? '?')}) · ${esc(ui.chainName(row.chainId))} · ${url ? link(label, url) : code(row.txHash ?? '?')}`);
      }
      lines.push(
        '',
        'Selama ada launch tertunda, launch baru diblokir supaya tidak terjadi dobel.',
        'Kalau kamu yakin transaksinya tidak akan terkonfirmasi (mis. sudah hilang dari mempool), kirim <code>/dismiss ya</code>.',
        '<i>Jika ternyata transaksinya berhasil, mengabaikannya berarti kamu bisa membuat launch dobel.</i>',
      );
      return void (await ctx.reply(lines.join('\n'), HTML));
    }
    try {
      const count = await deps.launcher.dismissPending();
      await ctx.reply(`Diabaikan: ${count} launch tertunda. Kamu bisa /launch lagi.`);
    } catch (err) {
      await ctx.reply(`Gagal: ${describeError(err)}`);
    }
  });

  bot.command('wallet', async (ctx) => {
    const chains = ui.supportedChains();
    const results = await Promise.allSettled(chains.map((id) => deps.wallet.nativeBalance(id)));
    const lines = ['👛 <b>Wallet launcher</b>', code(deps.wallet.address), ''];
    chains.forEach((id, index) => {
      const info = CHAINS[id];
      const result = results[index];
      const balance =
        result?.status === 'fulfilled'
          ? `${formatAmount(result.value, info?.nativeDecimals ?? 18)} ${info?.nativeSymbol ?? ''}`.trim()
          : 'gagal dibaca';
      lines.push(`${esc(ui.chainName(id))}: ${esc(balance)}`);
    });
    lines.push('', '<i>Kirim dana ke alamat ini untuk creation fee, gas, dan dev buy.</i>');
    await ctx.reply(lines.join('\n'), HTML);
  });

  bot.command('history', async (ctx) => {
    let rows;
    try {
      rows = await deps.history.recent('launch', 5);
    } catch (err) {
      return void (await ctx.reply(`Riwayat tidak bisa dibaca: ${describeError(err)}`));
    }
    if (rows.length === 0) return void (await ctx.reply('Belum ada launch tercatat.'));
    const lines = ['🕘 <b>Launch terakhir</b>', ''];
    for (const row of rows) {
      const explorer = ui.explorer(row.chainId);
      const status = { confirmed: '✅', sent: '⏳', reverted: '❌', unknown: '❓', failed: '❌' }[row.status];
      lines.push(
        `${status} <b>${esc(row.name ?? '?')}</b> ($${esc(row.symbol ?? '?')}) · ${esc(ui.chainName(row.chainId))} · ${esc(row.ts.slice(0, 16).replace('T', ' '))} UTC`,
      );
      if (row.token) lines.push(`   ${code(row.token)}`);
      if (row.txHash) lines.push(`   ${link(`tx ${shortAddress(row.txHash)}`, explorer('tx', row.txHash))}`);
    }
    await ctx.reply(lines.join('\n'), HTML);
  });
}
