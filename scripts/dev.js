#!/usr/bin/env node
/**
 * scripts/dev.js — OpenGits 一键开发环境（跨平台支持 macOS / Linux / Windows）
 *
 *   node scripts/dev.js          web + worker-go（默认）
 *   node scripts/dev.js all      web + worker-go
 *   node scripts/dev.js web      只启动 web
 *   node scripts/dev.js go       只启动 worker-go（自动预编二进制）
 *   node scripts/dev.js stop     停止全部
 *   node scripts/dev.js test     跑全量测试（TS + Go，不开服务）
 *
 * 前置：
 *   - 本地 PG 运行（docker compose up -d db，端口 5433）
 *   - npm run db:deploy && npm run db:generate
 */
const { spawn, execSync } = require('child_process');
const { mkdirSync, existsSync, statSync, readdirSync } = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, '.dev-logs');
const isWin = process.platform === 'win32';
const nodeBin = process.execPath;

// 加载 .env
try {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
} catch {}

mkdirSync(LOGS, { recursive: true });
mkdirSync(path.join(ROOT, 'storage/repos'), { recursive: true });
mkdirSync(path.join(ROOT, 'storage/assets'), { recursive: true });

const env = {
  ...process.env,
  NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=2048',
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://opengits:opengits_local_dev@localhost:5433/opengits_db?schema=public',
  INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN || 'dev-token',
  LLM_GATEWAY_URL: process.env.LLM_GATEWAY_URL || 'http://127.0.0.1:3000',
  SSE_GATEWAY_URL: process.env.SSE_GATEWAY_URL || 'http://127.0.0.1:8082',
  WORKER_SIDECAR_URL: process.env.WORKER_SIDECAR_URL || 'http://127.0.0.1:8082',
  WORKER_SIDECAR_ADDR: process.env.WORKER_SIDECAR_ADDR || ':8082',
  MCP_SIDECAR_ADDR: process.env.MCP_SIDECAR_ADDR || ':8081',
  WORKER_GO_TRANSCRIPTION: process.env.WORKER_GO_TRANSCRIPTION || '1',
  TRANSCRIPTION_MAX_PER_CYCLE: process.env.TRANSCRIPTION_MAX_PER_CYCLE || '4',
  TRANSCRIPTION_CONCURRENCY: process.env.TRANSCRIPTION_CONCURRENCY || '2',
  WORKER_SIDECAR_POOL_MAX: process.env.WORKER_SIDECAR_POOL_MAX || '24',
  MEMORY_LIMIT_BYTES: process.env.MEMORY_LIMIT_BYTES || '20000000000',
  DRILL_CONCURRENCY: process.env.DRILL_CONCURRENCY || '4',
  // repo 摄取 Go 独占(Node 管线已收刀):导入执行器必开——缺失会让 ImportJob 永久 QUEUED(与生产 compose 同款)
  WORKER_GO_IMPORT_JOBS: process.env.WORKER_GO_IMPORT_JOBS || '1',
  TARBALL_CACHE_ENTRY_CAP_MB: process.env.TARBALL_CACHE_ENTRY_CAP_MB || '1024',
  ARCHIVE_DOWNLOAD_TIMEOUT_MS: process.env.ARCHIVE_DOWNLOAD_TIMEOUT_MS || '300000',
};

const children = [];
let isStopping = false;
let goWatcherTimer = null;

function log(msg) { console.log(`[dev] ${msg}`); }

function tee(name, child) {
  const write = () => (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const l of lines) console.log(`  [${name}] ${l}`);
  };
  child.stdout?.on('data', write());
  child.stderr?.on('data', write());
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) log(`${name} exited (${code})`);
  });
  children.push(child);
}

function findGo() {
  if (process.env.GO_BIN && existsSync(process.env.GO_BIN)) return process.env.GO_BIN;
  try {
    const cmd = isWin ? 'where go' : 'which go';
    const found = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0].trim();
    if (found) return found;
  } catch {}
  // lint-ignore: PATH-001 — 跨平台固定安装位置的固定枚举（macOS/Linux/Windows 官方默认路径）
  for (const p of ['/opt/homebrew/bin/go', '/usr/local/bin/go', '/usr/local/go/bin/go', 'E:/tools/go/bin/go.exe', 'C:/Program Files/Go/bin/go.exe']) {
    if (existsSync(p)) return p;
  }
  return null;
}

function shouldRebuild(dir, bin) {
  if (!existsSync(bin)) return true;
  try {
    const binMtime = statSync(bin).mtimeMs;
    const checkDir = (d) => {
      const entries = readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && e.name !== 'testdata' && e.name !== '.git') {
          if (checkDir(full)) return true;
        } else if (e.isFile() && e.name.endsWith('.go')) {
          if (statSync(full).mtimeMs > binMtime) return true;
        }
      }
      return false;
    };
    return checkDir(path.join(ROOT, dir));
  } catch {
    return true;
  }
}

// Docker 回落编译的 Go 模块代理：默认跟随 go 环境自身配置（proxy.golang.org），
// 网络受限环境通过 GO_PROXY 注入镜像源（如 GO_PROXY=https://goproxy.cn,direct）
const goProxyFlag = process.env.GO_PROXY ? `-e GOPROXY=${process.env.GO_PROXY} ` : '';

function goBuild(dir, name) {
  const ext = isWin ? '.exe' : '';
  const bin = path.join(ROOT, `dev-${name}${ext}`);
  if (!shouldRebuild(dir, bin)) {
    log(`${name} binary up to date → ${path.basename(bin)}`);
    return bin;
  }
  log(`building ${name}...`);
  const go = findGo();
  if (go) {
    execSync(`"${go}" build -o "${bin}" .`, { cwd: path.join(ROOT, dir), stdio: 'pipe' });
  } else {
    // 宿主机无 go 编译器时，无缝回落 Docker 交叉编译当前系统原生二进制
    log(`local go not found, building via Docker golang:1.26-alpine for ${process.platform}/${process.arch}...`);
    const goos = isWin ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux');
    const goarch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const dockerCmd = `docker run --rm ${goProxyFlag}-v "${ROOT}:/src" -w "/src/${dir}" golang:1.26-alpine sh -c "CGO_ENABLED=0 GOOS=${goos} GOARCH=${goarch} go build -o /src/dev-${name}${ext} ."`;
    execSync(dockerCmd, { stdio: 'pipe' });
  }
  if (!isWin) {
    try { execSync(`chmod +x "${bin}"`); } catch {}
  }
  log(`${name} built → ${path.basename(bin)}`);
  return bin;
}

function compileI18n() {
  try {
    execSync('npm run i18n:compile', { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    log(`i18n compile warning: ${e.message}`);
  }
}

function startWeb() {
  compileI18n();
  log('web        → http://localhost:3000');
  const nextBin = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const c = spawn(nodeBin, [nextBin, 'dev', '-p', '3000'], {
    cwd: path.join(ROOT, 'apps/client'),
    env, stdio: 'pipe', shell: false,
  });
  tee('web', c);
}

function startGo() {
  const bin = goBuild('services/worker-sidecar', 'worker-go');
  let runningMtime = 0;
  let goProc = null;
  let restarting = false;

  const spawnWorker = () => {
    try { runningMtime = statSync(bin).mtimeMs; } catch { runningMtime = 0; }
    const builtAt = runningMtime ? new Date(runningMtime).toLocaleTimeString() : 'unknown';
    log(`worker-go  → :8082 (built ${builtAt})`);
    const c = spawn(bin, [], {
      cwd: ROOT, env, stdio: 'pipe', shell: false,
    });
    goProc = c;
    tee('go', c);
  };

  spawnWorker();

  // 监测 dev-worker-go 二进制 mtime 变更自动重启，杜绝重编译后内存旧进程滞留
  if (goWatcherTimer) clearInterval(goWatcherTimer);
  goWatcherTimer = setInterval(() => {
    if (isStopping || restarting) return;
    try {
      const currentMtime = statSync(bin).mtimeMs;
      if (currentMtime > 0 && runningMtime > 0 && currentMtime !== runningMtime) {
        restarting = true;
        log('worker-go binary updated on disk → restarting :8082...');
        setTimeout(() => {
          if (isStopping) return;
          const prev = goProc;
          if (!prev || prev.killed || prev.exitCode !== null) {
            spawnWorker();
            restarting = false;
            return;
          }
          let respawned = false;
          const finishRestart = () => {
            if (respawned || isStopping) return;
            respawned = true;
            spawnWorker();
            restarting = false;
          };
          prev.once('exit', finishRestart);
          try { prev.kill('SIGTERM'); } catch {}
          setTimeout(() => {
            if (!respawned && !isStopping) {
              try { prev.kill('SIGKILL'); } catch {}
              finishRestart();
            }
          }, 2000);
        }, 500);
      }
    } catch {}
  }, 2000);
}

function stopAll() {
  isStopping = true;
  if (goWatcherTimer) {
    clearInterval(goWatcherTimer);
    goWatcherTimer = null;
  }
  log('stopping...');
  for (const c of children) { try { c.kill(); } catch {} }
  for (const port of [3000, 8081, 8082]) {
    try {
      if (isWin) {
        const out = execSync('netstat -ano', { encoding: 'utf8' });
        for (const line of out.split('\n')) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const pid = line.trim().split(/\s+/).pop();
            if (pid && pid !== '0') {
              try { execSync(`taskkill /F /T /PID ${pid}`); log(`  killed :${port}`); } catch {}
            }
          }
        }
      } else {
        const pids = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
        if (pids) {
          const list = pids.split(/\s+/).filter(Boolean);
          for (const pid of list) {
            try { execSync(`kill -9 ${pid} 2>/dev/null || true`); log(`  killed :${port} (pid ${pid})`); } catch {}
          }
        }
      }
    } catch {}
  }
  log('done');
}

function runTests() {
  log('TS unit tests...');
  const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const vitest = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  try { execSync(`"${nodeBin}" "${tsx}" "${vitest}" run tests/unit`, { cwd: ROOT, stdio: 'inherit' }); log('TS ✅'); }
  catch { log('TS ❌'); return 1; }
  log('Go tests...');
  const go = findGo();
  for (const dir of ['services/worker-sidecar']) {
    try {
      if (go) {
        execSync(`"${go}" test ./...`, { cwd: path.join(ROOT, dir), stdio: 'inherit' });
      } else {
        execSync(`docker run --rm ${goProxyFlag}-v "${ROOT}:/src" -w "/src/${dir}" golang:1.26-alpine go test ./...`, { stdio: 'inherit' });
      }
      log(`${dir} ✅`);
    } catch {
      log(`${dir} ❌`);
      return 1;
    }
  }
  log('all tests passed');
  return 0;
}

const mode = process.argv[2] || 'default';

if (mode === 'stop') { stopAll(); process.exit(0); }
if (mode === 'test') { process.exit(runTests()); }

switch (mode) {
  case 'web': startWeb(); break;
  case 'go': startGo(); break;
  case 'default': case '': startWeb(); startGo(); break;
  default:
    console.log('用法: node scripts/dev.js [all|web|go|test|stop]');
    process.exit(1);
}

console.log('');
log('running (Ctrl+C to stop)');
log('web: http://localhost:3000  (首次编译慢盘可能需 2-5 分钟，后续有缓存)');
log('worker-go: :8082');
console.log('');

process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });
