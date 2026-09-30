import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from './fakes.js';
import { API_KEY, BOT_TOKEN, MockO1, MockTelegram, OWNER, PRIVATE_KEY, WALLET } from './mock-servers.js';
import { MockRpc } from './mock-rpc.js';

const REPO = join(import.meta.dirname, '..');
const SCRIPT = join(REPO, 'scripts', 'setup-vps.sh');

interface Run {
  code: number | null;
  out: string;
}

/** Runs a bash snippet with the installer sourced (its main() does not run when sourced). */
function sh(snippet: string, env: Record<string, string> = {}): Run {
  const result = spawnSync('bash', ['-c', `source "${SCRIPT}"\n${snippet}`], {
    env: { ...process.env, O1_ALLOW_NON_ROOT: '1', ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Runs one validator on a value passed through the environment (no shell quoting surprises). */
const yes = (fn: string, value: string) => sh(`${fn} "$V"`, { V: value }).code === 0;

// ---------------------------------------------------------------------------------------------
describe('setup-vps.sh: static checks', () => {
  it('is valid bash and prints usage', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    const help = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('sudo bash scripts/setup-vps.sh');
    expect(help.stdout).toContain('--reconfigure');
    expect(help.stdout).toContain('--uninstall');
  });

  it('rejects unknown options', () => {
    const run = spawnSync('bash', [SCRIPT, '--nope'], { encoding: 'utf8', env: { ...process.env, O1_ALLOW_NON_ROOT: '1' } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Opsi tidak dikenal');
  });

  it('refuses to install without root', () => {
    const run = sh('is_root() { return 1; }; require_root', { O1_ALLOW_NON_ROOT: '0' });
    expect(run.code).not.toBe(0);
    expect(run.out).toContain('Jalankan sebagai root');
    expect(sh('is_root() { return 1; }; require_root', { O1_ALLOW_NON_ROOT: '1' }).code).toBe(0);
  });

  it('stays in sync with the validation rules of the application', () => {
    // Same formats as src/config.ts, so a value accepted here is accepted by the bot.
    const cases: Array<[string, string, boolean]> = [
      ['valid_bot_token', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0', true],
      ['valid_bot_token', 'nope', false],
      ['valid_bot_token', '123:short', false],
      ['valid_user_ids', '123', true],
      ['valid_user_ids', '1, 2 ,3', true],
      ['valid_user_ids', '', false],
      ['valid_user_ids', 'abc', false],
      ['valid_user_ids', '1,,2', false],
      ['valid_user_ids', '1;2', false],
      ['valid_private_key', `0x${'ab'.repeat(32)}`, true],
      ['valid_private_key', 'ab'.repeat(32), true],
      ['valid_private_key', 'ab'.repeat(31), false],
      ['valid_private_key', `0x${'zz'.repeat(32)}`, false],
      ['valid_api_key', 'o1_launch_abcdef12_Sup3r-Secret_value', true],
      ['valid_api_key', 'o1_launch_ABCDEF12_x', false],
      ['valid_api_key', 'sk-123', false],
      ['valid_url', 'https://base-mainnet.g.alchemy.com/v2/AbC123', true],
      ['valid_url', 'http://127.0.0.1:8545', true],
      ['valid_url', 'https://x.test/a b', false],
      ['valid_url', 'https://x.test/#frag', false],
      ['valid_url', 'https://x.test/$HOME', false],
      ['valid_url', 'ftp://x.test', false],
      ['valid_chain_list', '8453', true],
      ['valid_chain_list', '8453,56,196', true],
      ['valid_chain_list', '1', false],
      ['valid_chain_list', '8453,999', false],
      ['valid_chain_list', '8453,', false],
      ['valid_chain_list', '', false],
    ];
    for (const [fn, value, expected] of cases) {
      expect(yes(fn, value), `${fn} ${JSON.stringify(value)}`).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('setup-vps.sh: functions', () => {
  it('maps CPU architectures to Node.js builds and rejects unknown ones', () => {
    const arch = (machine: string) => sh(`uname() { [[ "$1" == "-m" ]] && echo ${machine} || command uname "$@"; }; node_arch`);
    expect(arch('x86_64').out.trim()).toBe('x64');
    expect(arch('aarch64').out.trim()).toBe('arm64');
    expect(arch('armv7l').out.trim()).toBe('armv7l');
    const bad = arch('riscv64');
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('tidak didukung');
  });

  it('verifies SHA-256 checksums', () => {
    const dir = tempDir();
    const file = join(dir, 'f.bin');
    writeFileSync(file, 'hello');
    const good = createHash('sha256').update('hello').digest('hex');
    expect(sh(`verify_sha256 "${file}" ${good}`).code).toBe(0);
    const bad = sh(`verify_sha256 "${file}" ${'0'.repeat(64)}`);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('Checksum Node.js tidak cocok');
  });

  it('renders a hardened systemd unit that systemd itself accepts', () => {
    const dir = tempDir();
    const unit = join(dir, 'o1-launch-bot.service');
    const run = sh(`SERVICE_GROUP=root; render_unit > "${unit}"`, { O1_SERVICE_USER: 'root', O1_APP_DIR: '/srv/o1bot' });
    expect(run.code, run.out).toBe(0);
    const text = readFileSync(unit, 'utf8');
    for (const line of [
      'User=root',
      'WorkingDirectory=/srv/o1bot',
      'ReadWritePaths=/srv/o1bot/data',
      'Restart=on-failure',
      'NoNewPrivileges=true',
      'ProtectSystem=strict',
      'ProtectHome=true',
      'PrivateTmp=true',
      'UMask=0077',
      'StartLimitBurst=5',
      'WantedBy=multi-user.target',
    ]) expect(text, line).toContain(line);
    expect(text).toMatch(/ExecStart=\/\S*node dist\/index\.js/);
    // Node's JIT needs writable+executable memory; this hardening option would break the bot.
    expect(text).not.toContain('MemoryDenyWriteExecute');
    // The node binary must not live somewhere ProtectHome hides.
    expect(text).not.toMatch(/ExecStart=\/(root|home)\//);

    const verify = (file: string) => {
      const analyze = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
      if (analyze.error) return null; // systemd-analyze is not installed here
      // systemd-analyze exits 0 even for parse warnings, so judge by its output. The only tolerated
      // lines concern the deployment directory, which does not exist on the machine running the test.
      return `${analyze.stdout}${analyze.stderr}`.split('\n').filter((l) => l.trim() && !/\/srv\/o1bot|No such file/i.test(l));
    };
    const problems = verify(unit);
    if (problems) {
      expect(problems, problems.join('\n')).toEqual([]);
      // Control: the same check must flag a broken directive, otherwise the assertion above proves nothing.
      const broken = join(dir, 'broken.service');
      writeFileSync(broken, text.replace('Restart=on-failure', 'Restart=sometimes'));
      expect(verify(broken)?.join('\n')).toMatch(/restart/i);
    }
  });

  it('writes .env with mode 600, no leftovers, and stripped user ids', () => {
    const app = tempDir();
    const run = sh(
      `TELEGRAM_BOT_TOKEN=T PRIVATE_KEY=K O1_API_KEY=A ALLOWED_USER_IDS="1, 2" CHAINS=8453,56 RPC_URL_8453="https://rpc.example/v2/a?x=1&y=2"
       write_env_file`,
      { O1_APP_DIR: app },
    );
    expect(run.code, run.out).toBe(0);
    const env = readFileSync(join(app, '.env'), 'utf8');
    expect(env).toContain('TELEGRAM_BOT_TOKEN=T\n');
    expect(env).toContain('ALLOWED_USER_IDS=1,2\n');
    expect(env).toContain('ENABLED_CHAINS=8453,56\n');
    expect(env).toContain('RPC_URL_8453=https://rpc.example/v2/a?x=1&y=2\n');
    expect(env).not.toContain('RPC_URL_56'); // only written when the user provided one
    expect((statSync(join(app, '.env')).mode & 0o777).toString(8)).toBe('600');
    expect(spawnSync('bash', ['-c', `ls -A "${app}"`], { encoding: 'utf8' }).stdout.trim()).toBe('.env');
  });

  it('takes secrets from O1_SETUP_* presets only, validates them, and never prompts without a TTY', () => {
    const app = tempDir();
    const preset = {
      O1_APP_DIR: app,
      O1_SETUP_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      O1_SETUP_ALLOWED_USER_IDS: '42',
      O1_SETUP_PRIVATE_KEY: PRIVATE_KEY,
      O1_SETUP_O1_API_KEY: API_KEY,
    };
    const ok = sh('configure_env; echo "presets left: $(compgen -v O1_SETUP_ | wc -l)"; echo "key var: ${PRIVATE_KEY:-unset}"', { ...preset, O1_SETUP_CHAINS: '8453,56', O1_SETUP_RPC_URL_8453: 'http://rpc.test' });
    expect(ok.code, ok.out).toBe(0);
    const env = readFileSync(join(app, '.env'), 'utf8');
    expect(env).toContain(`PRIVATE_KEY=${PRIVATE_KEY}`);
    expect(env).toContain('ENABLED_CHAINS=8453,56');
    expect(env).toContain('RPC_URL_8453=http://rpc.test');
    // secrets are scrubbed from the shell (and so from every child process) once written
    expect(ok.out).toContain('presets left: 0');
    expect(ok.out).toContain('key var: unset');
    expect(ok.out).not.toContain(PRIVATE_KEY);

    expect(sh('configure_env', { ...preset, O1_APP_DIR: tempDir(), O1_SETUP_PRIVATE_KEY: 'not-a-key' }).out).toContain('O1_SETUP_PRIVATE_KEY tidak valid');
    const missing = sh('configure_env', { ...preset, O1_APP_DIR: tempDir(), O1_SETUP_O1_API_KEY: '' });
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain('Butuh input interaktif');
    // Robinhood Chain has no default RPC, so it cannot be enabled without one
    const noRpc = sh('configure_env', { ...preset, O1_APP_DIR: tempDir(), O1_SETUP_CHAINS: '4663' });
    expect(noRpc.code).not.toBe(0);
    expect(noRpc.out).toContain('RPC_URL_4663');
  });

  it('keeps an existing .env unless --reconfigure is used', () => {
    const app = tempDir();
    writeFileSync(join(app, '.env'), 'KEEP=me\n');
    const run = sh('configure_env; cat "$APP_DIR/.env"', { O1_APP_DIR: app });
    expect(run.code).toBe(0);
    expect(run.out).toContain('Memakai .env yang sudah ada');
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe('KEEP=me\n');
  });

  it('copies the app without .git, node_modules, dist, data or .env, and never touches the deployed .env/data', () => {
    const repo = tempDir();
    const app = tempDir();
    for (const dir of ['.git', 'node_modules/x', 'dist', 'data', 'src', 'scripts']) mkdirSync(join(repo, dir), { recursive: true });
    for (const [file, content] of Object.entries({
      '.git/config': 'secret-remote', 'node_modules/x/i.js': '', 'dist/old.js': '', 'data/launches.jsonl': 'repo-data',
      '.env': 'REPO_ENV=1', 'src/a.ts': 'new', 'package.json': '{}', 'scripts/setup-vps.sh': '#!/bin/bash', '.env.example': 'EX=1',
    })) writeFileSync(join(repo, file), content);
    // state of a previous installation
    for (const dir of ['data', 'src']) mkdirSync(join(app, dir), { recursive: true });
    writeFileSync(join(app, '.env'), 'DEPLOYED_ENV=1');
    writeFileSync(join(app, 'data/launches.jsonl'), 'deployed-data');
    writeFileSync(join(app, 'src/removed-upstream.ts'), 'stale');

    const run = sh(`REPO_DIR="${repo}"; sync_app`, { O1_APP_DIR: app });
    expect(run.code, run.out).toBe(0);

    expect(readFileSync(join(app, 'src/a.ts'), 'utf8')).toBe('new');
    expect(existsSync(join(app, 'src/removed-upstream.ts'))).toBe(false); // stale code is removed
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe('DEPLOYED_ENV=1');
    expect(readFileSync(join(app, 'data/launches.jsonl'), 'utf8')).toBe('deployed-data');
    for (const excluded of ['.git', 'node_modules', 'dist/old.js']) expect(existsSync(join(app, excluded)), excluded).toBe(false);
    expect(existsSync(join(app, '.env.example'))).toBe(true);
    expect(existsSync(join(app, 'package.json'))).toBe(true);
  });

  it('does not reinstall a suitable Node.js', () => {
    const run = sh('ensure_node');
    expect(run.code, run.out).toBe(0);
    expect(run.out).toMatch(/Node\.js v\d+\.\d+\.\d+ sudah terpasang/);
  });

  it('installs Node.js from a verified tarball (offline simulation of nodejs.org)', () => {
    const work = tempDir();
    const root = join(work, 'node-v22.99.0-linux-x64');
    mkdirSync(join(root, 'bin'), { recursive: true });
    for (const bin of ['node', 'npm', 'npx']) {
      writeFileSync(join(root, 'bin', bin), bin === 'node' ? '#!/bin/sh\necho v22.99.0\n' : '#!/bin/sh\nexit 0\n');
      chmodSync(join(root, 'bin', bin), 0o755);
    }
    const tarball = join(work, 'node-v22.99.0-linux-x64.tar.gz');
    expect(spawnSync('tar', ['-czf', tarball, '-C', work, 'node-v22.99.0-linux-x64']).status).toBe(0);
    const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    writeFileSync(join(work, 'SHASUMS256.txt'), `${'0'.repeat(64)}  node-v22.99.0-linux-arm64.tar.gz\n${sha}  node-v22.99.0-linux-x64.tar.gz\n`);

    const prefix = join(work, 'opt');
    const bin = join(work, 'bin');
    // `curl` is replaced by a function that serves the local files, so no network is involved.
    const fakeCurl = `curl() { local out="" url=""; while (($#)); do case "$1" in -o) out="$2"; shift;; http*) url="$1";; esac; shift; done; cp "${work}/$(basename "$url")" "$out"; }`;
    const run = sh(`${fakeCurl}; node_major() { echo 0; }; node_arch() { echo x64; }; install_node; "${bin}/node" -v`, { O1_NODE_PREFIX: prefix, O1_BIN_DIR: bin });
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain('v22.99.0');
    expect(existsSync(join(prefix, 'node-v22.99.0-linux-x64/bin/node'))).toBe(true);
    expect(spawnSync('readlink', [join(prefix, 'node')], { encoding: 'utf8' }).stdout.trim()).toBe(join(prefix, 'node-v22.99.0-linux-x64'));
    expect(spawnSync('readlink', [join(bin, 'npm')], { encoding: 'utf8' }).stdout.trim()).toBe(join(prefix, 'node/bin/npm'));
  });

  it('aborts and installs nothing when the Node.js checksum does not match', () => {
    const work = tempDir();
    const prefix = join(work, 'opt');
    const bin = join(work, 'bin');
    const fakeCurl = `curl() { local out="" url=""; while (($#)); do case "$1" in -o) out="$2"; shift;; http*) url="$1";; esac; shift; done;
      case "$url" in */SHASUMS256.txt) printf '%s  node-v22.0.0-linux-x64.tar.gz\\n' "${'a'.repeat(64)}" > "$out";; *) printf 'tampered download' > "$out";; esac; }`;
    const run = sh(`${fakeCurl}; node_arch() { echo x64; }; install_node`, { O1_NODE_PREFIX: prefix, O1_BIN_DIR: bin });
    expect(run.code).not.toBe(0);
    expect(run.out).toContain('Checksum Node.js tidak cocok');
    expect(existsSync(join(prefix, 'node'))).toBe(false);
    expect(existsSync(join(bin, 'node'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Slow tests: they run the real installer, which needs the npm registry and (for one test) nodejs.org.
//   npm run test:installer
const slow = process.env.O1_TEST_INSTALLER === '1';

describe.skipIf(!slow)('setup-vps.sh: real run against local mock services', () => {
  const tg = new MockTelegram();
  const o1 = new MockO1();
  const rpc = new MockRpc(8453);
  const work = tempDir();
  const app = join(work, 'app');
  const units = join(work, 'units');
  const fakeBin = join(work, 'fakebin');
  const log = join(work, 'systemctl.log');
  const state = join(work, 'service.started');

  beforeAll(async () => {
    await Promise.all([tg.start(), o1.start(), rpc.start()]);
    mkdirSync(fakeBin, { recursive: true });
    // systemd is not running in this sandbox: a stand-in records the calls and models start/stop/is-active.
    writeFileSync(
      join(fakeBin, 'systemctl'),
      `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  restart|start) [ "$FAKE_CRASH" = "1" ] || touch "${state}" ;;
  stop) rm -f "${state}" ;;
  is-active) [ -f "${state}" ] && exit 0 || exit 3 ;;
esac
exit 0
`,
    );
    chmodSync(join(fakeBin, 'systemctl'), 0o755);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([tg.stop(), o1.stop(), rpc.stop()]);
  });

  const install = (extra: Record<string, string> = {}, args: string[] = []) =>
    new Promise<Run>((resolve) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        NO_PROXY: `127.0.0.1,localhost,${process.env.NO_PROXY ?? ''}`,
        no_proxy: `127.0.0.1,localhost,${process.env.no_proxy ?? ''}`,
        O1_APP_DIR: app,
        O1_SERVICE_USER: spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim(),
        O1_ALLOW_NON_ROOT: '1',
        O1_SYSTEMD_DIR: units,
        O1_START_WAIT: '0',
        // Where the mock services live (the app reads these from its environment).
        TELEGRAM_API_ROOT: tg.url,
        O1_API_BASE_URL: `${new URL(o1.url).origin}/v1`,
        O1_SETUP_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        O1_SETUP_ALLOWED_USER_IDS: String(OWNER),
        O1_SETUP_PRIVATE_KEY: PRIVATE_KEY,
        O1_SETUP_O1_API_KEY: API_KEY,
        O1_SETUP_CHAINS: '8453',
        O1_SETUP_RPC_URL_8453: rpc.url,
        ...extra,
      };
      const proc = spawn('bash', [SCRIPT, ...args], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', (d) => (out += d));
      proc.stderr.on('data', (d) => (out += d));
      proc.on('close', (code) => resolve({ code, out }));
    });

  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const unitFile = () => join(units, 'o1-launch-bot.service');

  it('first install: builds, passes the doctor, installs and starts the service', async () => {
    const run = await install();
    expect(run.code, run.out).toBe(0);

    expect(run.out).toContain('Memasang dependensi');
    expect(run.out).toContain('Memeriksa persiapan');
    expect(run.out).toContain('Telegram: token valid, bot @e2e_bot');
    expect(run.out).toContain(`Wallet launcher: ${WALLET}`);
    expect(run.out).toContain('Siap. Jalankan bot dengan: npm start');
    expect(run.out).toContain('Service berjalan');
    for (const secret of [PRIVATE_KEY, PRIVATE_KEY.slice(2), API_KEY, 'E2eSecretValue', BOT_TOKEN]) expect(run.out).not.toContain(secret);

    // deployed tree
    expect(existsSync(join(app, 'dist/index.js'))).toBe(true);
    expect(existsSync(join(app, 'dist/doctorCli.js'))).toBe(true);
    expect(existsSync(join(app, '.git'))).toBe(false);
    expect(existsSync(join(app, 'node_modules/grammy'))).toBe(true);
    // Dev-only packages are pruned after the build (typescript itself stays: it is an optional peer of viem).
    for (const devOnly of ['vitest', 'tsx']) expect(existsSync(join(app, 'node_modules', devOnly)), devOnly).toBe(false);
    const env = readFileSync(join(app, '.env'), 'utf8');
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${BOT_TOKEN}`);
    expect(env).toContain('ENABLED_CHAINS=8453');
    expect((statSync(join(app, '.env')).mode & 0o777).toString(8)).toBe('600');
    expect((statSync(join(app, 'data')).mode & 0o777).toString(8)).toBe('700');

    // service
    const unit = readFileSync(unitFile(), 'utf8');
    expect(unit).toContain(`WorkingDirectory=${app}`);
    expect(unit).toContain(`ReadWritePaths=${app}/data`);
    expect(calls()).toEqual([
      'is-active --quiet o1-launch-bot',
      'daemon-reload',
      'enable o1-launch-bot',
      'restart o1-launch-bot',
      'is-active --quiet o1-launch-bot',
    ]);
  }, 300_000);

  it('the installed bot actually starts and polls Telegram', async () => {
    const before = tg.polls;
    const proc = spawn(process.execPath, ['dist/index.js'], {
      cwd: app,
      env: { ...process.env, TELEGRAM_API_ROOT: tg.url, O1_API_BASE_URL: `${new URL(o1.url).origin}/v1` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    try {
      const deadline = Date.now() + 30_000;
      while (tg.polls === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(tg.polls, out).toBeGreaterThan(before);
      expect(out).toContain('bot @e2e_bot berjalan');
      expect(out).toContain('chain Base (8453) siap');
    } finally {
      proc.kill('SIGTERM');
    }
  }, 60_000);

  it('update: reuses .env and data, stops the running service first and restarts it', async () => {
    const envBefore = readFileSync(join(app, '.env'), 'utf8');
    writeFileSync(join(app, 'data/launches.jsonl'), '{"marker":"keep"}\n');
    writeFileSync(log, '');

    const run = await install({
      // no presets: an update must not ask (or need) any secret again
      O1_SETUP_TELEGRAM_BOT_TOKEN: '', O1_SETUP_ALLOWED_USER_IDS: '', O1_SETUP_PRIVATE_KEY: '', O1_SETUP_O1_API_KEY: '', O1_SETUP_CHAINS: '', O1_SETUP_RPC_URL_8453: '',
    });
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain('Memakai .env yang sudah ada');
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe(envBefore);
    expect(readFileSync(join(app, 'data/launches.jsonl'), 'utf8')).toBe('{"marker":"keep"}\n');
    expect(calls()).toEqual([
      'is-active --quiet o1-launch-bot',
      'stop o1-launch-bot',
      'daemon-reload',
      'enable o1-launch-bot',
      'restart o1-launch-bot',
      'is-active --quiet o1-launch-bot',
    ]);
  }, 300_000);

  it('does NOT start the service when the doctor finds a problem', async () => {
    const env = readFileSync(join(app, '.env'), 'utf8').replace(API_KEY, 'o1_launch_deadbeef_WrongKeyValue-123');
    writeFileSync(join(app, '.env'), env);
    writeFileSync(log, '');

    const run = await install({
      O1_SETUP_TELEGRAM_BOT_TOKEN: '', O1_SETUP_ALLOWED_USER_IDS: '', O1_SETUP_PRIVATE_KEY: '', O1_SETUP_O1_API_KEY: '', O1_SETUP_CHAINS: '', O1_SETUP_RPC_URL_8453: '',
    });
    expect(run.code).toBe(1);
    expect(run.out).toContain('API o1: key ditolak');
    expect(run.out).toContain('service TIDAK dinyalakan');
    expect(calls().some((c) => c.startsWith('restart') || c.startsWith('enable'))).toBe(false);
    expect(run.out).not.toContain('WrongKeyValue');
  }, 300_000);

  it('reports a service that crashes right after starting', async () => {
    // restore a valid .env, then make the fake service refuse to stay up
    writeFileSync(join(app, '.env'), readFileSync(join(app, '.env'), 'utf8').replace('o1_launch_deadbeef_WrongKeyValue-123', API_KEY));
    writeFileSync(log, '');
    const run = await install({ FAKE_CRASH: '1', O1_SETUP_O1_API_KEY: '' });
    expect(run.code).not.toBe(0);
    expect(run.out).toContain('Service tidak aktif setelah dijalankan');
    expect(run.out).toContain('Bot gagal berjalan sebagai service');
  }, 300_000);

  it('--uninstall removes the service but keeps .env and data', async () => {
    writeFileSync(log, '');
    const run = await install({}, ['--uninstall']);
    expect(run.code, run.out).toBe(0);
    expect(existsSync(unitFile())).toBe(false);
    expect(calls()).toEqual(expect.arrayContaining(['stop o1-launch-bot', 'disable o1-launch-bot']));
    expect(existsSync(join(app, '.env'))).toBe(true);
    expect(existsSync(join(app, 'data/launches.jsonl'))).toBe(true);
  }, 60_000);
});

describe.skipIf(!slow)('setup-vps.sh: real Node.js download from nodejs.org', () => {
  it('downloads, verifies the checksum, extracts and runs a real Node.js', async () => {
    const reachable = await fetch('https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt', { signal: AbortSignal.timeout(15_000) }).then((r) => r.ok, () => false);
    if (!reachable) return; // offline environment: nothing to verify
    const work = tempDir();
    const run = sh('node_major() { echo 0; }; node_location_ok() { return 1; }; ensure_node; node -v; node -p "process.versions.node.split(\'.\')[0]"', {
      O1_NODE_PREFIX: join(work, 'opt'),
      O1_BIN_DIR: join(work, 'bin'),
    });
    expect(run.code, run.out).toBe(0);
    expect(run.out).toMatch(/Terpasang: v22\.\d+\.\d+/);
    expect(existsSync(join(work, 'bin/node'))).toBe(true);
    expect(existsSync(join(work, 'opt/node/bin/npm'))).toBe(true);
  }, 240_000);
});
