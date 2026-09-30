#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# o1 Launch Bot - installer / updater untuk VPS Linux (systemd).
#
# Jalankan dari DALAM clone repo ini, sebagai root:
#
#   sudo bash scripts/setup-vps.sh                 # pasang atau perbarui
#   sudo bash scripts/setup-vps.sh --reconfigure   # isi ulang rahasia dan tulis ulang .env
#   sudo bash scripts/setup-vps.sh --uninstall     # hentikan dan hapus service (data & .env tetap)
#
# Yang dilakukan (bisa dijalankan ulang dengan aman):
#   1. Memastikan Node.js >= 20 (kalau belum ada: unduh dari nodejs.org + verifikasi SHA-256)
#   2. Membuat user sistem tanpa login (o1bot) yang menjalankan bot
#   3. Menyalin aplikasi ke /opt/o1launchtele (tanpa .git, .env, data)
#   4. Menanyakan rahasia (input tersembunyi) dan menulis .env dengan izin 600
#   5. npm ci + build, lalu `npm run doctor` (bot TIDAK dinyalakan kalau doctor gagal)
#   6. Memasang service systemd yang hidup otomatis dan restart saat crash
#
# Tidak ada port yang perlu dibuka: bot hanya melakukan koneksi keluar.
# Skrip ini tidak pernah menerima atau mencetak rahasia lewat argumen baris perintah.
# ------------------------------------------------------------------------------
set -Eeuo pipefail

SERVICE_NAME="${O1_SERVICE_NAME:-o1-launch-bot}"
SERVICE_USER="${O1_SERVICE_USER:-o1bot}"
APP_DIR="${O1_APP_DIR:-/opt/o1launchtele}"
NODE_MAJOR="${O1_NODE_MAJOR:-22}"
NODE_PREFIX="${O1_NODE_PREFIX:-/opt}"
BIN_DIR="${O1_BIN_DIR:-/usr/local/bin}"
SYSTEMD_DIR="${O1_SYSTEMD_DIR:-/etc/systemd/system}"
SKIP_SYSTEMD="${O1_SKIP_SYSTEMD:-0}"
ALLOW_NON_ROOT="${O1_ALLOW_NON_ROOT:-0}"
START_WAIT="${O1_START_WAIT:-6}"
MIN_NODE_MAJOR=20

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="install"
RECONFIGURE=0
SERVICE_GROUP=""

# --- tampilan -----------------------------------------------------------------
if [[ -t 1 ]]; then
  C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""
fi
say()  { printf '%s==>%s %s\n' "$C_OK" "$C_OFF" "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '%s!!%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '%sxx%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

is_root() { [[ $EUID -eq 0 ]]; }

# --- validasi input (sama dengan aturan di src/config.ts) ------------------------
valid_bot_token()   { [[ "$1" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]]; }
valid_user_ids()    { [[ "$1" =~ ^[0-9]{1,15}([[:space:]]*,[[:space:]]*[0-9]{1,15})*$ ]]; }
valid_private_key() { [[ "$1" =~ ^(0x)?[0-9a-fA-F]{64}$ ]]; }
valid_api_key()     { [[ "$1" =~ ^o1_launch_[0-9a-f]{8}_[A-Za-z0-9_-]+$ ]]; }
# https://..., atau http:// hanya ke mesin ini. Tanpa spasi, kutip, #, $, backtick atau backslash: aman untuk format .env.
valid_url() {
  [[ "$1" =~ ^https?://[^[:space:]\"\'\`\#\$\\]+$ ]] || return 1
  [[ "$1" =~ ^https:// ]] && return 0
  [[ "$1" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(/|$) ]]
}

# Petunjuk singkat yang ditambahkan ke pesan "tidak valid" untuk validator yang aturannya tidak kasat mata.
validator_hint() {
  case "$1" in
    valid_url) printf '%s' ' (harus https://..., atau http:// hanya ke localhost)' ;;
  esac
}

valid_chain_list() {
  local id
  [[ "$1" =~ ^[0-9]+(,[0-9]+)*$ ]] || return 1
  for id in ${1//,/ }; do
    case "$id" in 8453|4663|143|5042|56|196) ;; *) return 1 ;; esac
  done
}

chain_name() {
  case "$1" in
    8453) echo "Base" ;; 4663) echo "Robinhood Chain" ;; 143) echo "Monad" ;;
    5042) echo "Arc" ;; 56) echo "BSC" ;; 196) echo "X Layer" ;; *) echo "Chain $1" ;;
  esac
}

# RPC publik bawaan (sama dengan src/chains.ts). Robinhood dan Arc tidak punya bawaan.
default_rpc() {
  case "$1" in
    8453) echo "https://mainnet.base.org" ;;
    56)   echo "https://bsc-dataseed.binance.org" ;;
    196)  echo "https://rpc.xlayer.tech" ;;
    143)  echo "https://rpc.monad.xyz" ;;
    *)    echo "" ;;
  esac
}

# --- prasyarat -----------------------------------------------------------------
require_root() {
  is_root && return 0
  [[ "$ALLOW_NON_ROOT" == "1" ]] && return 0
  die "Jalankan sebagai root: sudo bash scripts/setup-vps.sh"
}

check_platform() {
  [[ "$(uname -s)" == "Linux" ]] || die "Skrip ini hanya untuk Linux."
  if [[ -f /etc/alpine-release ]]; then
    die "Alpine (musl) belum didukung karena Node.js resmi butuh glibc. Pakai Debian/Ubuntu."
  fi
  if [[ "$SKIP_SYSTEMD" != "1" ]] && ! command -v systemctl >/dev/null 2>&1; then
    die "systemd tidak ditemukan. Pakai distro dengan systemd, atau jalankan manual (lihat README)."
  fi
  command -v tar >/dev/null 2>&1 || die "Perintah 'tar' tidak ditemukan."
}

# --- Node.js ---------------------------------------------------------------------
node_major() {
  if command -v node >/dev/null 2>&1; then
    node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
  else
    echo 0
  fi
}

# Node di bawah /home atau /root tidak bisa diakses service yang diisolasi (ProtectHome).
node_location_ok() {
  local p
  p="$(command -v node 2>/dev/null)" || return 1
  p="$(readlink -f "$p")"
  [[ "$p" != /home/* && "$p" != /root/* ]]
}

node_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7l)        echo "armv7l" ;;
    *) die "Arsitektur CPU tidak didukung: $(uname -m)" ;;
  esac
}

verify_sha256() {
  local file="$1" expected="$2" actual
  actual="$(sha256sum "$file" | cut -d' ' -f1)"
  [[ "$actual" == "$expected" ]] || die "Checksum Node.js tidak cocok (diharapkan $expected, dapat $actual). Unduhan dibatalkan."
}

install_node() {
  command -v curl >/dev/null 2>&1 || die "Perintah 'curl' dibutuhkan untuk memasang Node.js."
  command -v sha256sum >/dev/null 2>&1 || die "Perintah 'sha256sum' dibutuhkan untuk memverifikasi Node.js."
  local arch base tmp line sha file target bin
  arch="$(node_arch)"
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tmp="$(mktemp -d)"

  say "Mengunduh Node.js ${NODE_MAJOR}.x (${arch}) dari nodejs.org"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || die "Gagal mengunduh daftar checksum Node.js."
  line="$(grep -E " node-v[0-9.]+-linux-${arch}\.tar\.gz\$" "$tmp/SHASUMS256.txt" | head -n1 || true)"
  [[ -n "$line" ]] || die "Build Node.js untuk linux-${arch} tidak ditemukan di nodejs.org."
  sha="${line%% *}"
  file="${line##* }"
  curl -fsSL "$base/$file" -o "$tmp/$file" || die "Gagal mengunduh $file."
  verify_sha256 "$tmp/$file" "$sha"

  target="$NODE_PREFIX/${file%.tar.gz}"
  mkdir -p "$target" "$BIN_DIR"
  tar -xzf "$tmp/$file" -C "$target" --strip-components=1
  ln -sfn "$target" "$NODE_PREFIX/node"
  for bin in node npm npx; do ln -sfn "$NODE_PREFIX/node/bin/$bin" "$BIN_DIR/$bin"; done
  rm -rf "$tmp"

  export PATH="$BIN_DIR:$PATH"
  hash -r
  node -v >/dev/null 2>&1 || die "Node.js terpasang tetapi tidak bisa dijalankan (glibc terlalu lama?). Pakai distro yang lebih baru."
  note "Terpasang: $(node -v) di $target"
}

ensure_node() {
  export PATH="$BIN_DIR:$PATH"
  if (( $(node_major) >= MIN_NODE_MAJOR )) && command -v npm >/dev/null 2>&1 && node_location_ok; then
    say "Node.js $(node -v) sudah terpasang"
    return 0
  fi
  install_node
}

# --- user & berkas aplikasi -----------------------------------------------------
ensure_user() {
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    say "User $SERVICE_USER sudah ada"
  else
    say "Membuat user sistem $SERVICE_USER (tanpa login)"
    useradd --system --home-dir "$APP_DIR" --no-create-home --shell "$(command -v nologin || echo /usr/sbin/nologin)" "$SERVICE_USER"
  fi
  SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
}

fix_permissions() {
  is_root || return 0
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR"
  chmod 750 "$APP_DIR"
  chmod 700 "$APP_DIR/data"
  if [[ -f "$APP_DIR/.env" ]]; then chmod 600 "$APP_DIR/.env"; fi
}

sync_app() {
  mkdir -p "$APP_DIR" "$APP_DIR/data"
  if [[ "$(cd "$APP_DIR" && pwd)" == "$REPO_DIR" ]]; then
    say "Skrip dijalankan langsung dari $APP_DIR; tidak ada yang disalin"
    return 0
  fi
  say "Menyalin aplikasi dari $REPO_DIR ke $APP_DIR"
  # Hapus kode lama supaya berkas yang sudah dihapus di repo tidak ikut ter-build; .env dan data dipertahankan.
  rm -rf "$APP_DIR/src" "$APP_DIR/test" "$APP_DIR/scripts"
  tar -C "$REPO_DIR" \
    --exclude=./.git --exclude=./node_modules --exclude=./dist --exclude=./data --exclude=./.env \
    -cf - . | tar -C "$APP_DIR" -xf -
}

# Menjalankan perintah sebagai user service, di dalam APP_DIR.
as_service_user() {
  if [[ "$(id -un)" == "$SERVICE_USER" ]]; then
    ( cd "$APP_DIR" && HOME="$APP_DIR" "$@" )
  elif command -v runuser >/dev/null 2>&1; then
    ( cd "$APP_DIR" && runuser -u "$SERVICE_USER" -- env HOME="$APP_DIR" PATH="$PATH" "$@" )
  else
    ( cd "$APP_DIR" && sudo -n -u "$SERVICE_USER" env HOME="$APP_DIR" PATH="$PATH" "$@" )
  fi
}

# --- konfigurasi (.env) -----------------------------------------------------------
# ask VAR LABEL VALIDATOR SECRET(0|1) [DEFAULT] [REQUIRED(1|0)]
# Nilai bisa datang dari variabel lingkungan O1_SETUP_<VAR> (untuk otomasi/tes); selain itu ditanyakan
# di terminal. Input rahasia dibaca tersembunyi dan tidak pernah lewat argumen baris perintah.
ask() {
  local var="$1" label="$2" validator="$3" secret="$4" default="${5:-}" required="${6:-1}"
  local preset="O1_SETUP_${var}" value=""
  if [[ -n "${!preset:-}" ]]; then
    value="${!preset}"
    "$validator" "$value" || die "Nilai $preset tidak valid$(validator_hint "$validator")."
  elif [[ ! -t 0 ]]; then
    if [[ "$required" == "1" && -z "$default" ]]; then
      die "Butuh input interaktif untuk $var. Jalankan langsung di terminal SSH (atau set $preset)."
    fi
    value="$default"
  else
    while :; do
      if [[ "$secret" == "1" ]]; then
        read -rsp "$label: " value || die "Input ditutup."
        printf '\n'
      else
        read -rp "$label${default:+ [$default]}: " value || die "Input ditutup."
      fi
      if [[ -z "$value" ]]; then value="$default"; fi
      if [[ -z "$value" && "$required" == "0" ]]; then break; fi
      if [[ -n "$value" ]] && "$validator" "$value"; then break; fi
      warn "Format tidak valid$(validator_hint "$validator"), coba lagi."
    done
  fi
  printf -v "$var" '%s' "$value"
}

write_env_file() {
  local file="$APP_DIR/.env" tmp id rpc_var
  tmp="$(umask 077 && mktemp "$APP_DIR/.env.XXXXXX")"
  {
    printf '# Dibuat oleh scripts/setup-vps.sh pada %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# Ubah dengan: sudo nano %s  lalu  sudo systemctl restart %s\n' "$file" "$SERVICE_NAME"
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN"
    printf 'ALLOWED_USER_IDS=%s\n' "${ALLOWED_USER_IDS//[[:space:]]/}"
    printf 'PRIVATE_KEY=%s\n' "$PRIVATE_KEY"
    printf 'O1_API_KEY=%s\n' "$O1_API_KEY"
    printf 'ENABLED_CHAINS=%s\n' "$CHAINS"
    for id in ${CHAINS//,/ }; do
      rpc_var="RPC_URL_${id}"
      if [[ -n "${!rpc_var:-}" ]]; then printf '%s=%s\n' "$rpc_var" "${!rpc_var}"; fi
    done
    printf 'LOG_LEVEL=info\n'
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

configure_env() {
  local env_file="$APP_DIR/.env" id
  if [[ -f "$env_file" && "$RECONFIGURE" -eq 0 ]]; then
    say "Memakai .env yang sudah ada (pakai --reconfigure untuk mengisi ulang)"
    return 0
  fi
  say "Mengisi konfigurasi"
  note "Input rahasia tidak ditampilkan dan tidak masuk histori shell."
  note "Token bot: dari @BotFather. API key: launch.o1.exchange/developers."
  note "PRIVATE KEY: pakai wallet KHUSUS bot ini dengan dana secukupnya, bukan wallet utama."

  ask TELEGRAM_BOT_TOKEN "Token bot Telegram" valid_bot_token 1
  ask ALLOWED_USER_IDS "ID Telegram yang boleh memakai bot (pisahkan koma; tidak tahu? kirim pesan ke @userinfobot)" valid_user_ids 0
  ask PRIVATE_KEY "Private key wallet launcher (64 hex)" valid_private_key 1
  ask O1_API_KEY "API key o1" valid_api_key 1
  ask CHAINS "Chain yang dipakai (ID dipisah koma: Base=8453, BSC=56, X Layer=196, Monad=143, Robinhood=4663, Arc=5042)" valid_chain_list 0 "8453"

  for id in ${CHAINS//,/ }; do
    if [[ -n "$(default_rpc "$id")" ]]; then
      ask "RPC_URL_${id}" "RPC $(chain_name "$id") (Enter = RPC publik bawaan; RPC pribadi lebih andal)" valid_url 0 "" 0
    else
      ask "RPC_URL_${id}" "RPC $(chain_name "$id") (wajib, tidak ada bawaan)" valid_url 0 "" 1
    fi
  done

  write_env_file
  # Rahasia tidak boleh terwariskan ke proses anak (npm, node).
  unset TELEGRAM_BOT_TOKEN PRIVATE_KEY O1_API_KEY
  local preset
  for preset in $(compgen -v O1_SETUP_ || true); do unset "$preset"; done
  note "Tersimpan di $env_file (izin 600, hanya bisa dibaca user $SERVICE_USER dan root)"
}

# --- build & pengecekan --------------------------------------------------------------
build_app() {
  say "Memasang dependensi (npm ci)"
  as_service_user npm ci --no-audit --no-fund --loglevel=error
  say "Build"
  as_service_user npm run --silent build
  as_service_user npm prune --omit=dev --no-audit --no-fund --loglevel=error
}

run_doctor() {
  say "Memeriksa persiapan (npm run doctor)"
  as_service_user npm run --silent doctor
}

# --- systemd -------------------------------------------------------------------------
render_unit() {
  local node_bin
  node_bin="$(readlink -f "$(command -v node)")"
  cat <<EOF
[Unit]
Description=o1 Launch Telegram Bot
Documentation=https://github.com/fdlr28/o1Launchtele
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${APP_DIR}
ExecStart=${node_bin} dist/index.js
Restart=on-failure
RestartSec=10
# Saat dihentikan, bot menunggu launch yang sedang berjalan sampai selesai (maks 240 detik) lalu mengirim
# pesan hasilnya (maks 15 detik); systemd tidak boleh memotongnya lebih cepat dari itu.
TimeoutStopSec=270

# Pengamanan: bot hanya butuh jaringan keluar dan folder data miliknya sendiri.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=${APP_DIR}/data
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
}

service_active() { systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; }

stop_service_if_running() {
  [[ "$SKIP_SYSTEMD" == "1" ]] && return 0
  if service_active; then
    say "Menghentikan service sementara untuk pembaruan"
    systemctl stop "$SERVICE_NAME"
  fi
}

install_service() {
  local unit="$SYSTEMD_DIR/$SERVICE_NAME.service"
  say "Memasang service systemd ($SERVICE_NAME)"
  mkdir -p "$SYSTEMD_DIR"
  render_unit > "$unit.tmp"
  mv "$unit.tmp" "$unit"
  chmod 644 "$unit"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
  systemctl restart "$SERVICE_NAME"

  # Beri waktu bot menyambung ke Telegram; kalau langsung crash, tampilkan lognya.
  sleep "$START_WAIT"
  if service_active; then
    say "Service berjalan"
  else
    warn "Service tidak aktif setelah dijalankan. Log terakhir:"
    journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
    die "Bot gagal berjalan sebagai service. Perbaiki penyebab di log di atas lalu jalankan skrip ini lagi."
  fi
}

uninstall_service() {
  local unit="$SYSTEMD_DIR/$SERVICE_NAME.service"
  require_root
  if [[ "$SKIP_SYSTEMD" != "1" ]]; then
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$unit"
    systemctl daemon-reload 2>/dev/null || true
  fi
  say "Service $SERVICE_NAME dihapus."
  note "Berkas, .env, dan data tetap ada di $APP_DIR."
  note "Untuk menghapus semuanya: sudo rm -rf $APP_DIR && sudo userdel $SERVICE_USER"
}

print_summary() {
  say "Selesai"
  if [[ "$SKIP_SYSTEMD" == "1" ]]; then
    note "systemd dilewati. Jalankan manual: cd $APP_DIR && npm start"
    return 0
  fi
  cat <<EOF

  Status      : systemctl status $SERVICE_NAME
  Log         : journalctl -u $SERVICE_NAME -f
  Restart     : sudo systemctl restart $SERVICE_NAME
  Ubah .env   : sudo nano $APP_DIR/.env && sudo systemctl restart $SERVICE_NAME
  Perbarui    : cd $REPO_DIR && git pull && sudo bash scripts/setup-vps.sh

Lanjut di Telegram: kirim /wallet lalu /launch ke bot kamu.
EOF
}

# --- alur utama ----------------------------------------------------------------------
parse_args() {
  while (($#)); do
    case "$1" in
      --reconfigure) RECONFIGURE=1 ;;
      --uninstall)   MODE="uninstall" ;;
      -h|--help)     usage; exit 0 ;;
      *) die "Opsi tidak dikenal: $1 (lihat --help)" ;;
    esac
    shift
  done
}

main() {
  trap 'warn "Terjadi kesalahan tak terduga di baris $LINENO. Periksa pesan di atasnya."' ERR
  parse_args "$@"
  if [[ "$MODE" == "uninstall" ]]; then uninstall_service; return 0; fi

  require_root
  check_platform
  say "Menyiapkan o1 Launch Bot di $APP_DIR"
  ensure_node
  ensure_user
  sync_app
  configure_env
  fix_permissions
  stop_service_if_running
  build_app
  fix_permissions

  if ! run_doctor; then
    warn "Doctor menemukan masalah, jadi service TIDAK dinyalakan."
    warn "Perbaiki .env:  sudo nano $APP_DIR/.env   (atau ulangi isian dengan --reconfigure)"
    warn "Lalu jalankan lagi:  sudo bash scripts/setup-vps.sh"
    exit 1
  fi

  if [[ "$SKIP_SYSTEMD" == "1" ]]; then
    say "systemd dilewati (O1_SKIP_SYSTEMD=1)"
  else
    install_service
  fi
  print_summary
}

# Hanya jalankan main() saat dieksekusi langsung, bukan saat di-source (dipakai oleh tes).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
