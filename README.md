# o1 Launch Bot (Telegram)

Bot Telegram untuk **launch token di [o1 Launchpad](https://launch.o1.exchange/)** lewat
[Public API o1](https://docs.o1.exchange/launchpad/api/introduction). Kamu mengisi semuanya lewat tombol
di Telegram, bot menyiapkan transaksi lewat API o1, lalu menandatanganinya dengan wallet launcher milikmu.

| Yang kamu minta | Di bot |
| --- | --- |
| Pilih pair (quote token) | Crypto (native, stablecoin, dll.) dan **Stocks**, dengan pencarian dan halaman. Daftar diambil langsung dari `/config` o1 sehingga selalu sesuai chain dan tipe launch. |
| Set tax | Buy/sell tax, pembagian sisa ke **creator / dividen / burn**, minimal holding dividen, anti-snipe, penerima creator fee. Divalidasi terhadap kebijakan live dari o1. |
| Set gambar | Kirim foto atau file (PNG, JPG, WEBP, GIF, maks 2 MB); tipe dicek dari isi file, bukan dari klaim Telegram. |
| Set social | Website, X, Telegram (+ deskripsi). `@username` otomatis dijadikan link. |
| Pilihan dev buy | ON/OFF, jumlah dalam pair yang dipilih, slippage, dan waktu beli. **Baca bagian [Dev buy](#dev-buy-baca-ini)**: ini bukan atomic. |

Chain yang didukung API o1: Base, Robinhood Chain, Monad, Arc, BSC, X Layer. Tipe launch: **Tax** dan **Standard**.

## Cara kerja

```
Telegram ──▶ bot ──▶ API o1 (/launches/prepare) ──▶ transaksi BELUM ditandatangani
                       │                                   │
                       │                       bot memeriksa (chain, pengirim,
                       │                       kontrak tujuan, batas value)
                       ▼                                   ▼
                 IPFS + alamat "01"              wallet launcher menandatangani
                                                 dan broadcast ke RPC chain
```

API o1 tidak pernah menandatangani atau broadcast apa pun; bot yang melakukannya dengan wallet dari `PRIVATE_KEY`.

## Persiapan

1. **Node.js 20 atau lebih baru.**
2. **Bot Telegram**: buat lewat [@BotFather](https://t.me/BotFather), simpan tokennya.
3. **API key o1**: buka <https://launch.o1.exchange/developers>, hubungkan wallet, lalu buat key dengan scope
   `config:read`, `tokens:read`, `launches:prepare`, `swaps:quote`, `swaps:prepare`.
   (Key hanya ditampilkan sekali.)
4. **Wallet launcher**: buat wallet **khusus** untuk bot ini (jangan wallet utamamu) dan isi dana secukupnya
   untuk *creation fee*, *gas*, dan dev buy. Contoh fee saat ini: 0,001 ETH di Base/Robinhood, 0,003 BNB di BSC,
   0,02 OKB di X Layer, 100 MON di Monad, 2 USDC native di Arc. Bot membaca fee live dari o1 dan menampilkannya di Review.
5. **RPC**: Base, BSC, X Layer, dan Monad punya RPC publik bawaan (ada rate limit; untuk serius pakai RPC pribadi).
   Robinhood Chain dan Arc harus kamu isi sendiri (`RPC_URL_4663`, `RPC_URL_5042`).

## Menjalankan

```bash
npm install
cp .env.example .env      # isi minimal TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, PRIVATE_KEY, O1_API_KEY
npm run build
npm start
```

Untuk pengembangan: `npm run dev` (auto-reload). Agar tetap hidup di server, jalankan dengan `pm2`, `systemd`, atau
sejenisnya. Bot memakai long-polling, jadi tidak perlu domain atau webhook.

**Tidak tahu Telegram ID-mu?** Isi `ALLOWED_USER_IDS` dengan angka apa pun, jalankan bot, kirim `/id` ke bot
(perintah ini boleh dipakai siapa saja), lalu isi ID yang muncul dan restart.

Saat start, bot memeriksa: konfigurasi `.env`, RPC tiap chain (chain id harus cocok, kalau tidak chain itu
dinonaktifkan), dan API key o1.

## Cara pakai

Kirim `/launch`. Muncul satu panel dengan tombol; semua tampilan mengedit panel yang sama supaya chat tetap rapi.

1. **Chain**, **Tipe** (Tax ⇄ Standard), dan **Pair**. Pair native chain dipilih otomatis.
2. **Nama**, **Simbol** (`$PEPE` otomatis jadi `PEPE`), **Gambar**, **Deskripsi**, **Website / X / Telegram**.
3. **Tax** (khusus tipe Tax): buy/sell tax, pembagian creator/dividen/burn, min. holding dividen, anti-snipe,
   penerima creator fee. Ada preset cepat, dan bot menampilkan rincian per trade
   (protocol / creator / dividen / burn) seperti hitungan resmi o1.
4. **Dev Buy** (opsional).
5. **Review & Launch**: bot memvalidasi semuanya, mengecek saldo, dan menampilkan fee. Tekan **Konfirmasi & Launch**.

Perintah lain: `/wallet` (alamat dan saldo), `/history` (launch terakhir), `/cancel`, `/help`, `/id`.
Setelah launch, **Launch lagi** membuka draft baru yang mewarisi chain, pair, tax, sosial, dan dev buy
(nama, simbol, gambar, dan deskripsi harus diisi ulang).

### Tentang tax

- Tax bersifat **inklusif**: bagian protocol o1 sudah termasuk di dalam angka yang kamu pilih
  (10% dari tax, minimal 0,5% dan maksimal 1% dari nilai trade, sesuai kebijakan saat ini).
  Sisanya dibagi ke creator / dividen / burn sesuai persenmu.
- Angka tax, pembagian, dan min. holding **tidak bisa diubah setelah launch**.
- Batas (mis. 1–10%) dibaca live dari o1, bukan hardcode.
- Creator fee tipe **Tax** masuk ke alamat yang kamu isi (disarankan wallet pribadimu). Untuk tipe **Standard**,
  o1 tidak menyediakan pilihan penerima lewat API: creator fee terkumpul untuk **wallet bot** dan diklaim lewat
  *Profile › Fees* di launch.o1.exchange dengan wallet tersebut.

### Dev buy (baca ini)

API publik o1 **belum menyediakan atomic dev buy** (`createLaunchAndBuy`); itu hanya ada di alur browser dan bot X milik o1.
Karena itu dev buy di sini adalah **swap biasa setelah launch terkonfirmasi**, lewat `swaps/quote` dan `swaps/prepare`:

1. Bot menunggu token terindeks di API o1 (biasanya beberapa detik).
2. Mode **Tunggu anti-snipe** (bawaan): bot menunggu surcharge pembukaan (mulai 99%, turun ke fee normal dalam 20 detik di
   Base/Robinhood/Monad/BSC/X Layer, tidak ada di Arc Standard; untuk Tax hanya jika anti-snipe ON) selesai sebelum membeli.
   Mode **Segera**: membeli secepat mungkin dan **bisa kena surcharge sampai 99%**.
3. Dev buy tetap membayar fee/tax beli normal.

Akibatnya **sniper bisa membeli lebih dulu**. Kalau kamu butuh dev buy yang benar-benar atomic, lakukan lewat web o1.
FDV pembukaan token sekitar US$4.000, jadi dev buy kecil pun bisa mengambil porsi supply yang besar.
Kalau dev buy gagal, launch-nya tetap sukses dan bot memberitahumu.

> Bentuk respons `swaps/quote` dan `swaps/prepare` hanya sebagian terdokumentasi, jadi bot membacanya secara toleran
> dan menolak dengan pesan jelas bila formatnya tak dikenali. Jalur dev buy **belum diuji ke API o1 sungguhan**; lihat
> [Status pengujian](#status-pengujian).

## Keamanan

- **Hot wallet.** `PRIVATE_KEY` ada di `.env` server. Pakai wallet khusus berisi dana secukupnya. Jangan pernah commit
  `.env` (sudah di `.gitignore`), dan jangan bagikan isinya.
- **Whitelist.** Hanya user di `ALLOWED_USER_IDS` yang bisa memakai bot, dan hanya di chat pribadi (grup diabaikan).
- **Bot tidak menandatangani sembarangan.** Sebelum menandatangani transaksi apa pun dari API, bot memastikan:
  chain benar, pengirim adalah wallet bot, tujuan adalah kontrak o1 yang dikenal dari `/config` (atau token pair untuk
  `approve`), `value` tidak melebihi fee yang kamu setujui di Review, token ERC-20 hanya menerima `approve`, dan
  tanda tangan Permit2 hanya untuk pair dan spender yang cocok. `STRICT_TARGETS=false` melonggarkan hanya daftar
  kontrak tujuan.
- **Chain id RPC diverifikasi** saat start (viem tidak melakukannya sendiri untuk akun lokal).
- **Fee dijaga.** Jika fee launch naik sesudah Review, launch dibatalkan dan kamu diminta Review ulang.
- **Log bersih.** Private key, API key, dan token bot disensor dari log (termasuk di URL). Hash transaksi tetap terlihat.
- **Tidak ada resend buta.** Hash transaksi dicatat ke `data/launches.jsonl` *sebelum* menunggu receipt. Kalau receipt
  tidak datang tepat waktu, bot memberi tahu bahwa transaksi terkirim tetapi belum terkonfirmasi, meminta kamu mengecek
  hash di explorer, dan tidak mengirim ulang.
- Jika API key atau token bot bocor: cabut/buat ulang dari sumbernya. Jika private key bocor: pindahkan dana segera.

## Batasan yang perlu kamu tahu

- **Rate limit API o1:** 3 persiapan launch per menit per API key, dan 1 per menit serta 25 per hari per wallet creator.
  Bila terkena, bot menunggu otomatis sesuai `Retry-After` (sampai 90 detik).
- **Satu launch dalam satu waktu** (satu wallet = satu aliran nonce).
- **Draft disimpan di memori**: hilang jika bot restart. Launch yang sudah dikirim tetap tercatat di `/history`.
- **Tanpa atomic dev buy** (lihat di atas) dan tanpa klaim fee di bot (klaim lewat web o1).
- Supply tetap 1 miliar token dan likuiditas terkunci permanen; itu aturan kontrak o1, bukan bot.

## Pemecahan masalah

| Gejala | Penyebab / solusi |
| --- | --- |
| `Konfigurasi .env tidak valid` | Bot menyebut semua variabel yang salah sekaligus; perbaiki lalu jalankan ulang. |
| `chain … dinonaktifkan: RPC mengembalikan chain id …` | `RPC_URL_<id>` menunjuk ke jaringan lain. Perbaiki URL-nya. |
| `API key o1 ditolak` | Key salah/dicabut, atau kurang scope (lihat daftar scope di atas). |
| Chain tidak muncul di tombol Chain | RPC-nya belum diisi atau gagal verifikasi (lihat log start). |
| `Pair … tidak tersedia` | Registrasi pair berubah di sisi o1; pilih pair lain. |
| `Transaksi … ditolak demi keamanan` | Respons API tidak cocok dengan konfigurasi o1 (mis. router tak dikenal). Jangan dilewati begitu saja; bila yakin, coba `STRICT_TARGETS=false`. |
| `Estimasi gas gagal` | Transaksi akan revert (deadline habis, fee berubah, saldo kurang). Coba Review ulang. |
| Dev buy: `Token belum terindeks` | API o1 belum mengindeks token; beli manual di launch.o1.exchange. |

## Pengembangan

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

```
src/
  index.ts            # entry: config, verifikasi RPC + API key, start bot
  config.ts           # validasi .env (semua error sekaligus)
  chains.ts           # daftar chain, RPC/explorer bawaan
  logger.ts           # log dengan sensor rahasia
  errors.ts           # pesan error ramah user
  domain/             # murni, tanpa I/O: satuan & persen eksak, validator, tax, draft, waktu dev buy
  o1/                 # klien API o1, katalog /config (cache), builder request, helper swap
  wallet/             # viem: verifikasi chain id, estimasi gas, tanda tangan, receipt
  services/           # launcher (pipeline), guard (keamanan tx), review, riwayat JSONL
  bot/                # grammY: panel, keyboard, teks, input, callback, perintah, launch di background
test/                 # unit + alur bot + end-to-end proses nyata (lihat di bawah)
```

### Status pengujian

Lingkungan tempat bot ini dibangun **tidak punya akses ke Telegram, API o1, maupun jaringan blockchain**, jadi bot
**belum pernah dijalankan ke layanan sungguhan**. Yang sudah diuji (`npm test`, 200+ test):

- Perhitungan tax dicocokkan dengan angka resmi di dokumentasi o1 (mis. 3% dengan split 60/40 → protocol 0,5%,
  creator 1,5%, dividen 1%).
- Body `POST /launches/prepare` divalidasi terhadap **skema OpenAPI o1** (dan test negatif membuktikan validatornya bisa menolak).
- Klien HTTP (retry, `Retry-After`, `Idempotency-Key`, problem+json), guard keamanan, launcher (revert, timeout, plan
  kedaluwarsa, approval, semua varian dev buy), dan wallet terhadap **server JSON-RPC tiruan** (transaksi yang ditandatangani
  dibaca kembali dan dicocokkan byte demi byte).
- Seluruh alur Telegram dengan update palsu, serta satu tes **end-to-end** yang menjalankan proses bot sungguhan
  melawan server tiruan Telegram, API o1, dan RPC.

Yang **belum** terverifikasi: perilaku API o1 asli (terutama bentuk respons swap untuk dev buy), Telegram asli, dan
eksekusi on-chain nyata. **Untuk launch pertama**, mulai dari chain dengan biaya kecil dan dana secukupnya, dan periksa
hasilnya di explorer.
