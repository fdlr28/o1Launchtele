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

Bot harus jalan di **mesin atau server milikmu sendiri**, bukan di sesi Claude Code cloud: kunci privat tidak
seharusnya masuk ke sana, dan bot perlu hidup terus-menerus.

### Di VPS (disarankan)

Butuh VPS Linux dengan systemd (Debian/Ubuntu/RHEL dan turunannya). Login lewat SSH, lalu:

```bash
git clone https://github.com/fdlr28/o1Launchtele.git
cd o1Launchtele
sudo bash scripts/setup-vps.sh
```

Repo ini publik, jadi tidak perlu login GitHub. Baca skripnya dulu kalau mau (`less scripts/setup-vps.sh`); skrip ini
menangani private key, jadi jangan dijalankan lewat `curl | bash`.

Skrip akan:

1. Memastikan Node.js 20+ (kalau belum ada, mengunduh dari nodejs.org dan **memverifikasi SHA-256**).
2. Membuat user sistem tanpa login (`o1bot`) yang menjalankan bot, dan menyalin aplikasi ke `/opt/o1launchtele`.
3. Menanyakan **token bot, ID Telegram, private key, API key o1, chain, dan RPC**. Input rahasia tersembunyi, tidak masuk
   histori shell, dan hanya ditulis ke `/opt/o1launchtele/.env` dengan izin `600`.
4. `npm ci`, build, lalu `npm run doctor`. **Kalau doctor menemukan masalah, service tidak dinyalakan.**
5. Memasang service systemd `o1-launch-bot` yang hidup otomatis saat boot dan restart sendiri kalau crash.

Tidak ada port yang perlu dibuka (bot hanya melakukan koneksi keluar).

| Perlu apa | Perintah |
| --- | --- |
| Lihat status | `systemctl status o1-launch-bot` |
| Lihat log | `journalctl -u o1-launch-bot -f` |
| Ubah `.env` | `sudo nano /opt/o1launchtele/.env && sudo systemctl restart o1-launch-bot` |
| Perbarui bot | `cd o1Launchtele && git pull && sudo bash scripts/setup-vps.sh` (rahasia tidak ditanya lagi) |
| Isi ulang rahasia | `sudo bash scripts/setup-vps.sh --reconfigure` |
| Hapus service | `sudo bash scripts/setup-vps.sh --uninstall` (`.env` dan data tetap ada) |

Tidak tahu Telegram ID-mu? Kirim pesan ke `@userinfobot`. Atau isi sembarang angka (mis. `1`), jalankan bot, kirim `/id`
ke bot, lalu ganti `ALLOWED_USER_IDS` di `.env` dan restart.

Saat pembaruan, service dihentikan dulu supaya build tidak berbenturan dengan proses yang berjalan. Jangan memperbarui
saat sebuah launch sedang berlangsung.

### Manual (PC atau HP dengan Termux)

```bash
git clone https://github.com/fdlr28/o1Launchtele.git
cd o1Launchtele
npm install
cp .env.example .env      # isi minimal TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, PRIVATE_KEY, O1_API_KEY
npm run build
npm run doctor            # cek semua persiapan (tidak mengirim transaksi apa pun)
npm start
```

Di Termux: `pkg install nodejs git`, lalu langkah di atas, dan aktifkan `termux-wake-lock` supaya proses tidak dimatikan
saat layar padam. VPS lebih andal untuk pemakaian rutin. Untuk pengembangan: `npm run dev` (auto-reload).

### `npm run doctor`

Memeriksa: format `.env`, token Telegram, RPC tiap chain (chain id harus cocok) beserta saldo wallet, API key o1
(`config:read` dan `tokens:read`), dan apakah launch Tax/Standard tersedia di tiap chain (jumlah pair dan creation fee).
Hasilnya tidak memuat nilai rahasia, jadi aman ditempel kalau kamu butuh bantuan. Scope `launches:prepare`,
`swaps:quote`, dan `swaps:prepare` tidak bisa dicek tanpa efek samping, jadi pastikan sendiri key-mu punya ketiganya.

Saat start, bot juga memeriksa konfigurasi `.env`, RPC tiap chain (chain id harus cocok, kalau tidak chain itu
dinonaktifkan), dan API key o1. Bot memakai long-polling, jadi tidak perlu domain atau webhook.

## Cara pakai

Kirim `/launch`. Muncul satu panel dengan tombol; semua tampilan mengedit panel yang sama supaya chat tetap rapi.

1. **Chain**, **Tipe** (Tax ⇄ Standard), dan **Pair**. Pair native chain dipilih otomatis.
2. **Nama**, **Simbol** (`$PEPE` otomatis jadi `PEPE`), **Gambar**, **Deskripsi**, **Website / X / Telegram**.
3. **Tax** (khusus tipe Tax): buy/sell tax, pembagian creator/dividen/burn, min. holding dividen, anti-snipe,
   penerima creator fee. Ada preset cepat, dan bot menampilkan rincian per trade
   (protocol / creator / dividen / burn) seperti hitungan resmi o1.
4. **Dev Buy** (opsional).
5. **Review & Launch**: bot memvalidasi semuanya, mengecek saldo, dan menampilkan fee. Tekan **Konfirmasi & Launch**.

Perintah lain: `/wallet` (alamat dan saldo), `/history` (launch terakhir), `/dismiss` (lihat bagian
[Launch tertunda](#launch-tertunda)), `/cancel`, `/help`, `/id`.
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
- **Bot tidak menandatangani sembarangan.** Respons API o1 tidak dipercaya begitu saja: dana yang bisa keluar dibatasi
  ke tujuan, jenis panggilan, dan jumlah yang kamu setujui. Seluruh rencana transaksi diperiksa **sebelum satu pun
  ditandatangani**:
  - chain benar dan pengirim adalah wallet bot; maksimal 4 langkah, hanya langkah terakhir yang boleh berupa panggilan;
  - panggilan hanya boleh ke kontrak yang tepat untuk langkahnya: *factory* untuk launch, *router* untuk swap. Permit2,
    escrow, hook, dan kontrak lain tidak pernah boleh dipanggil;
  - token ERC-20 (pair atau token fee) hanya menerima `approve`, ke spender yang dikenal, dengan jumlah tidak lebih dari
    fee/dev buy yang kamu setujui (Permit2 satu-satunya yang boleh menerima allowance tak terbatas, karena hanya bisa
    memakai apa yang diizinkan permit terpisah);
  - total `value` semua langkah tidak melebihi fee (atau jumlah dev buy) yang kamu setujui di Review;
  - tanda tangan Permit2 hanya untuk pair yang dipilih, router sebagai spender, jumlah tidak melebihi dev buy, allowance
    maksimal 31 hari dan tanda tangan maksimal 24 jam.

  Kontrak dikenali dari `/config` o1 untuk chain yang dipilih. Pemeriksaan ini **tidak bisa dimatikan**; kontrak tambahan
  yang sudah kamu verifikasi sendiri bisa didaftarkan di `EXTRA_ALLOWED_TARGETS` (kosong secara bawaan).
- **Review terikat ke drafnya.** Konfirmasi hanya berlaku untuk draf yang persis sama dengan yang di-review; kalau ada yang
  diubah sesudahnya, kamu diminta Review ulang. Setiap upaya launch (sukses atau gagal) juga butuh Review baru.
- **Fee dijaga.** Jika fee launch (jumlah *atau* mata uangnya) berubah naik sesudah Review, launch dibatalkan.
- **Rencana kedaluwarsa tidak ditandatangani.** Umur rencana dihitung dari cap waktu API (bukan jam server-mu); rencana
  yang tinggal beberapa detik disiapkan ulang, dan rencana tanpa waktu kedaluwarsa yang valid ditolak.
- **Chain id RPC diverifikasi** saat start (viem tidak melakukannya sendiri untuk akun lokal).
- **Hanya koneksi aman.** Semua URL (RPC, API o1, Telegram, explorer) harus `https://`; `http://` hanya untuk
  localhost. Redirect dari API o1 ditolak supaya API key tidak ikut terkirim ke tempat lain.
- **Log dan pesan bersih.** Private key, API key, token bot, dan kunci di dalam URL RPC disensor dari log **dan** dari
  pesan error yang dikirim ke Telegram. Hash transaksi tetap terlihat.
- **Tidak ada resend buta, tidak ada dobel.** Transaksi ditandatangani lebih dulu, hash-nya **ditulis ke
  `data/launches.jsonl` sebelum dikirim** (kalau tidak bisa ditulis, transaksi tidak dikirim), lalu dikirim tepat satu kali
  tanpa retry tersembunyi. Kalau jawaban node hilang, bot mencari hash itu di chain dan tidak pernah mengirim ulang.
- **Launch tertunda memblokir launch baru** sampai jelas hasilnya (lihat di bawah).
- **Berhenti dengan rapi.** Saat service dihentikan (`systemctl stop/restart`), bot berhenti menerima perintah baru,
  menunggu launch yang sedang berjalan sampai selesai (maks 2 menit), dan mengirim pesan hasilnya sebelum keluar.
- Jika API key atau token bot bocor: cabut/buat ulang dari sumbernya. Jika private key bocor: pindahkan dana segera.

### Launch tertunda

Kalau transaksi launch terkirim tetapi hasilnya tidak jelas (receipt tidak datang, jawaban node hilang, atau bot mati di
tengah jalan), bot **memblokir launch baru** supaya tidak terjadi launch dobel, dan memberi tahu kamu (termasuk saat bot
menyala kembali). Yang perlu kamu lakukan:

1. Buka hash transaksinya di explorer (ada di pesan bot dan di `/dismiss`).
2. Kalau **berhasil**, tidak perlu apa-apa: bot menyelesaikannya sendiri begitu chain melaporkannya.
3. Kalau **tidak akan pernah terkonfirmasi** (hilang dari mempool), kirim `/dismiss ya`. Transaksi yang tidak dikenal chain
   selama 30 menit juga dianggap gugur otomatis.

Jangan gunakan `/dismiss ya` kalau transaksinya mungkin masih akan masuk: itu bisa menyebabkan launch dobel.

Angka yang ambigu ditolak: `1.000` atau `1,000` bisa berarti satu atau seribu, jadi bot minta kamu menulis `1000` (ribuan)
atau `1.0000` (desimal).

## Batasan yang perlu kamu tahu

- **Rate limit API o1:** 3 persiapan launch per menit per API key, dan 1 per menit serta 25 per hari per wallet creator.
  Bila terkena, bot menunggu otomatis sesuai `Retry-After` (sampai 90 detik).
- **Satu launch dalam satu waktu** (satu wallet = satu aliran nonce).
- **Draft disimpan di memori**: hilang jika bot restart. Launch yang sudah dikirim tetap tercatat di `/history`.
- **Isi calldata tidak didekode.** Bot menjaga *ke mana*, *jenis panggilan*, dan *berapa dana* yang keluar, tetapi tidak
  bisa membaca parameter token di dalam calldata `createLaunch` (nama, tax, penerima fee): itu dibuat API o1 dari
  permintaanmu. Setelah launch, cek tokennya di explorer / launch.o1.exchange, terutama untuk launch pertama.
- **Dev buy dibatasi** ke jumlah yang kamu setujui: allowance/permit yang diminta API lebih besar dari itu (mis. allowance
  Permit2 lebih dari 31 hari) ditolak, dan dev buy-nya dilaporkan gagal (launch-nya tetap sukses).
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
| `Transaksi … ditolak demi keamanan` | Respons API tidak cocok dengan konfigurasi o1 (mis. kontrak tak dikenal, approve terlalu besar). Jangan dilewati begitu saja. Hanya bila kamu sudah memverifikasi sendiri kontraknya, daftarkan di `EXTRA_ALLOWED_TARGETS`. |
| `Ada launch sebelumnya yang hasilnya belum jelas` | Lihat [Launch tertunda](#launch-tertunda). |
| `Draft berubah sejak Review` | Ada yang diubah setelah Review. Buka Review lagi lalu konfirmasi. |
| `… harus URL https://` | Semua URL harus `https://` (atau `http://localhost`). Perbaiki di `.env`. |
| `STRICT_TARGETS sudah dihapus` | Opsi untuk mematikan pemeriksaan target sudah dihapus (selalu aktif). Hapus barisnya dari `.env`. |
| `Estimasi gas gagal` | Transaksi akan revert (deadline habis, fee berubah, saldo kurang). Coba Review ulang. |
| Dev buy: `Token belum terindeks` | API o1 belum mengindeks token; beli manual di launch.o1.exchange. |

## Pengembangan

```bash
npm run typecheck        # tsc --noEmit
npm test                 # vitest (cepat, tanpa jaringan)
npm run test:installer   # tambahan: jalankan installer VPS sungguhan (butuh npm registry dan nodejs.org)
```

```
scripts/
  setup-vps.sh        # installer/updater VPS: Node, user, .env, build, doctor, systemd
src/
  index.ts            # entry: config, verifikasi RPC + API key, start bot, shutdown rapi
  doctor.ts           # pemeriksaan setup (npm run doctor); doctorCli.ts = entry CLI-nya
  config.ts           # validasi .env (semua error sekaligus)
  chains.ts           # daftar chain, RPC/explorer bawaan
  logger.ts           # log dengan sensor rahasia
  errors.ts           # pesan error ramah user
  domain/             # murni, tanpa I/O: satuan & persen eksak, validator, tax, draft, waktu dev buy
  o1/                 # klien API o1, katalog /config (cache), builder request, helper swap
  wallet/             # viem: verifikasi chain id, estimasi gas, tanda tangan lokal, broadcast sekali, status hash
  services/           # launcher (pipeline), guard (keamanan tx), review, riwayat JSONL (write-ahead)
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
