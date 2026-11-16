#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────
 * MCP 负载压测脚本（零依赖，Node 18+ 原生 fetch 直打 stateless JSON-RPC）
 *
 * 用法（或 `npm run loadtest:mcp -- <参数>`）：
 *   node tests/load/mcp-loadtest.mjs \
 *     --url http://localhost/api/mcp/<owner>/<repo> \
 *     --token <API_TOKEN> \
 *     --mode search --steps 1,2,4,8,16 --step-seconds 20
 *
 * 目标选择：
 *   - 经 caddy 标准入口（mcp-go 边缘）：  http://localhost/api/mcp/...
 *   - Go sidecar 直连（绕过 caddy）：     http://localhost:8081/api/mcp/...
 *   - 本地 dev 模式（npm run dev）：       http://localhost:3000/api/mcp/...
 *
 * 模式：
 *   handshake  tools/list（免配额方法——测固定守卫 + stateless 重建开销）
 *   search     tools/call search（全链路重路径：鉴权/配额/重建/FTS/遥测）
 *   mixed      交替以上两者
 *
 * 多用户模拟（--token 逗号分隔多个 token，每个 worker 轮询持有其一）：
 *   限流按 userId 计，单 token 吞吐天花板 = RPM/60（普通 30 RPM → 0.5 rps，
 *   admin 600 RPM → 10 rps）。要测「多人使用」的聚合容量，必须一 worker 一 token：
 *     --token tok1,tok2,...,tok16
 *
 * Token 准备（Bearer API Token，MCP 连接页创建）：
 *   默认配额 30 RPM / 100 次·日会把压测快速打成 429，两条路任选：
 *   a) 用 ADMIN/SUPER_ADMIN 账号的 token（600 RPM、日配额无限）
 *   b) 对测试用户临时提额（压完改回）：
 *      docker compose exec db psql -U opengits -d opengits_db \
 *        -c "UPDATE \"User\" SET \"mcpRpmLimit\"=100000, \"dailyMcpQuota\"=0 WHERE email='<测试账号>'"
 *   429 在结果中单独计数——出现即提示「配额在限速」，该档 RPS 不是服务容量。
 *
 * 跨机器可迁移指标（本机绝对 RPS 不可迁移，以下指标可迁移）：
 *   1. cpu-ms/req（--cpu-pids）：每请求消耗的 CPU 毫秒 = 服务需求（service demand）。
 *      服务器容量 ≈ 核数 × 1000 / cpu-ms-per-req（再乘 0.7~0.8 并行效率折扣）。
 *      用 `ps` 累计 cputime 差分测量，dev 直跑进程传 PID；容器场景在 Linux 宿主机
 *      用 `docker top <svc>` 找宿主 PID 后同样传 PID。
 *   2. 拐点形状：RPS 随并发的增益骤降 + p95/p99 发散的并发档（与机器无关的饱和信号）。
 *   3. pg 连接占用（--pg-sample）：DB 池是否顶格（连接是硬顶，与机器无关）。
 *   4. Little 定律校验：并发 ≈ RPS × 延迟(ms)/1000，偏离即排队（等待 CPU/池/锁）。
 *
 * 高性能开发机注意（绝对数字是上界，不是生产值）：
 *   先裸跑一轮得上界；再用 CPU 限速覆盖模拟小规格 VPS 跑一轮得保守值：
 *      docker compose -f docker-compose.yml -f docker-compose.loadtest.yml up -d
 *   两轮的 cpu-ms/req 应基本一致（可迁移）；不一致说明测量被本机干扰。
 *
 * 可选 --pg-sample：压测期间每秒采样 pg_stat_activity 连接数（本机需可用 docker
 * compose；不可用则自动告警跳过）。压测会产生 McpCallLog 遥测行，介意可事后清理：
 *   docker compose exec db psql -U opengits -d opengits_db \
 *     -c "DELETE FROM \"McpCallLog\" WHERE \"createdAt\" > now() - interval '2 hours'"
 * ─────────────────────────────────────────────────────────────
 */

import { execFileSync } from 'node:child_process';

const USAGE = `用法: node tests/load/mcp-loadtest.mjs --url <mcp端点> --token <API_TOKEN> [选项]
  --mode handshake|search|mixed   压测模式（默认 search）
  --query <关键词>                search 模式的检索词（默认 "context window"）
  --token tok1[,tok2,...]         压测 token，逗号分隔多个即模拟多用户轮询
  --steps 1,2,4,8,16              并发阶梯（逗号分隔）
  --step-seconds 20               每档持续时间（秒）
  --think 100                     每请求后的思考时间（ms，实际为 0~2 倍随机抖动）
  --warmup 3                      正式压测前的单并发预热秒数
  --timeout 30000                 单请求超时（ms）
  --pg-sample                     采样 pg_stat_activity 连接数（需本机 docker compose）
  --cpu-pids a=123,b=456          采样进程累计 CPU 时间（label=pid），输出 cpu-ms/req`;

// ── 参数解析（零依赖手写）──
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) { out[key.slice(2)] = true; continue; }
    out[key.slice(2)] = val;
    i++;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!args.url || !args.token) {
  console.error(USAGE);
  process.exit(1);
}

const BASE_URL = String(args.url).replace(/\/+$/, '');
const TOKENS = String(args.token).split(',').map((t) => t.trim()).filter(Boolean);
const MODE = ['handshake', 'search', 'mixed'].includes(args.mode) ? args.mode : 'search';
const QUERY = String(args.query || 'context window');
const STEPS = String(args.steps || '1,2,4,8,16').split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
const STEP_SECONDS = Number(args['step-seconds'] || 20);
const THINK_MS = Number(args.think ?? 100);
const WARMUP_SECONDS = Number(args['warmup'] ?? 3);
const TIMEOUT_MS = Number(args.timeout || 30000);
const PG_SAMPLE = !!args['pg-sample'];
const CPU_PIDS = String(args['cpu-pids'] || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((pair) => {
    const [label, pid] = pair.split('=');
    return { label, pid: parseInt(pid, 10) };
  })
  .filter((p) => p.label && Number.isFinite(p.pid));

if (STEPS.length === 0) {
  console.error('错误: --steps 解析为空');
  process.exit(1);
}
if (CPU_PIDS.length > 0 && CPU_PIDS.some((p) => !Number.isFinite(p.pid))) {
  console.error('错误: --cpu-pids 格式应为 label=pid,label=pid');
  process.exit(1);
}

// ── JSON-RPC 请求构造（stateless：每请求独立，无需 initialize 会话）──
let rpcId = 0;
function buildRequest(mode) {
  const id = ++rpcId;
  if (mode === 'handshake') {
    return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
  }
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search', arguments: { query: QUERY } } };
}

function modeFor(i) {
  if (MODE !== 'mixed') return MODE;
  return i % 2 === 0 ? 'search' : 'handshake';
}

// ── 单请求（原生 fetch；undici 默认 keep-alive 连接复用，贴近真实 MCP 客户端）──
async function post(body, token) {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.arrayBuffer().catch(() => {}); // 必须消费完 body 才释放连接
  return res.status;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 累计 CPU 时间读取（ps cputime 单调递增，档位边界两次快照差分即该档 CPU 消耗）──
function readCputimeSeconds(pid) {
  try {
    // 同步执行仅在档位边界调用（每档 2 次），开销可忽略
    const out = execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    return parseCputime(String(out).trim());
  } catch {
    return null; // 进程退出/不可见 → 该组件本轮记 null（不计入）
  }
}

function parseCputime(s) {
  // 格式 "MM:SS.xx" 或 "HH:MM:SS.xx"（部分平台含 .xx 百分秒）
  const m = s.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [, h, mm, ss] = m;
  return (Number(h || 0) * 60 + Number(mm)) * 60 + Number(ss);
}

function snapshotCpu() {
  const snap = {};
  for (const { label, pid } of CPU_PIDS) snap[label] = readCputimeSeconds(pid);
  return snap;
}

// ── 每档统计 ──
function createStats() {
  return {
    latencies: [],
    byStatus: new Map(), // status -> count（非 2xx 记负维度见 errors）
    errors: new Map(),   // 网络错误 code -> count
  };
}

function recordOk(stats, status, latencyMs) {
  stats.latencies.push(latencyMs);
  stats.byStatus.set(status, (stats.byStatus.get(status) || 0) + 1);
}

function recordErr(stats, label, latencyMs) {
  stats.latencies.push(latencyMs);
  stats.errors.set(label, (stats.errors.get(label) || 0) + 1);
}

function percentile(sorted, q) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

async function runStep(concurrency, seconds, { quiet = false } = {}) {
  const stats = createStats();
  const stopAt = Date.now() + seconds * 1000;
  let requestIndex = 0;
  const cpuStart = snapshotCpu();

  const workers = Array.from({ length: concurrency }, async (_, workerId) => {
    // 多 token：每个 worker 固定持有轮询到的 token —— 模拟独立用户各自的限流窗口
    const token = TOKENS[workerId % TOKENS.length];
    while (Date.now() < stopAt) {
      const mode = modeFor(requestIndex++);
      const body = buildRequest(mode);
      const t0 = performance.now();
      try {
        const status = await post(body, token);
        const dt = performance.now() - t0;
        if (status >= 200 && status < 300) recordOk(stats, status, dt);
        else recordErr(stats, `HTTP ${status}`, dt);
      } catch (e) {
        recordErr(stats, e?.name === 'TimeoutError' ? 'timeout' : e?.cause?.code || e?.name || 'network', performance.now() - t0);
      }
      if (THINK_MS > 0) await sleep(THINK_MS * Math.random() * 2);
    }
  });
  await Promise.all(workers);

  const cpuEnd = snapshotCpu();
  const total = stats.latencies.length;
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const rps = total / seconds;
  const errCount = [...stats.errors.values()].reduce((a, b) => a + b, 0);
  const q429 = stats.errors.get('HTTP 429') || 0;

  // 跨机器可迁移指标：每请求 CPU 毫秒 & 单核等效 RPS & Little 定律校验
  const cpuMsPerReq = {};
  let coresConsumed = 0;
  for (const { label } of CPU_PIDS) {
    const s = cpuStart[label];
    const e = cpuEnd[label];
    if (s === null || e === null || e < s) continue;
    const ms = ((e - s) * 1000) / Math.max(total, 1);
    cpuMsPerReq[label] = ms;
    coresConsumed += (e - s) / seconds;
  }
  const singleCoreRps = coresConsumed > 0 ? rps / coresConsumed : null;
  const littleL = (rps * (percentile(sorted, 0.5) || 0)) / 1000; // L = λW（p50 近似）

  const result = {
    concurrency, total, rps,
    p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99), max: sorted[sorted.length - 1] || 0,
    errCount, q429, errors: stats.errors, statuses: stats.byStatus,
    cpuMsPerReq, coresConsumed, singleCoreRps, littleL,
  };
  if (!quiet) printStep(result);
  return result;
}

function fmtMs(v) {
  return Number.isFinite(v) ? `${Math.round(v)}ms` : '—';
}

function printStep(r) {
  const errDetail = r.errCount > 0 ? ` err=${r.errCount}${r.q429 > 0 ? `(429:${r.q429})` : ''}` : '';
  const cpuDetail = Object.entries(r.cpuMsPerReq)
    .map(([label, ms]) => `${label}=${ms.toFixed(1)}cpu-ms/req`)
    .join(' ');
  console.log(
    `[c=${String(r.concurrency).padStart(2)}] ` +
    `rps=${r.rps.toFixed(1).padStart(7)} ` +
    `p50=${fmtMs(r.p50).padStart(8)} p95=${fmtMs(r.p95).padStart(8)} ` +
    `p99=${fmtMs(r.p99).padStart(8)} max=${fmtMs(r.max).padStart(9)}${errDetail}`
  );
  if (cpuDetail) {
    const coreEst = r.singleCoreRps !== null ? `（折算单核 ~${r.singleCoreRps.toFixed(0)} rps，本档吃掉 ${r.coresConsumed.toFixed(2)} 核）` : '';
    console.log(`         cpu: ${cpuDetail}${coreEst}`);
  }
}

// ── 可选：pg_stat_activity 连接数采样（DB 常是 12-15 次往返的真正漏斗）──
let pgPeak = 0;
let pgSamples = 0;
let pgBroken = false;
async function samplePgOnce() {
  if (pgBroken) return;
  const { execFile } = await import('node:child_process');
  const sql = "SELECT count(*) FROM pg_stat_activity WHERE datname='opengits_db'";
  execFile('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'opengits', '-d', 'opengits_db', '-t', '-A', '-c', sql],
    { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        pgBroken = true;
        console.warn(`[pg-sample] 采样失败（已跳过）: ${err.message.split('\n')[0]}`);
        return;
      }
      const n = parseInt(String(stdout).trim(), 10);
      if (Number.isFinite(n)) {
        pgSamples++;
        pgPeak = Math.max(pgPeak, n);
      }
    });
}

// ── 主流程 ──
console.log('MCP 负载压测');
console.log(`  目标: ${BASE_URL}`);
console.log(`  模式: ${MODE}${MODE !== 'handshake' ? ` (query="${QUERY}")` : ''}`);
console.log(`  token: ${TOKENS.length} 个${TOKENS.length > 1 ? '（worker 轮询，模拟多用户）' : ''}`);
console.log(`  阶梯: ${STEPS.join(' → ')} 每档 ${STEP_SECONDS}s，思考 0~${THINK_MS * 2}ms 随机`);
if (CPU_PIDS.length > 0) console.log(`  cpu 采样: ${CPU_PIDS.map((p) => `${p.label}=pid${p.pid}`).join(' ')}`);
console.log(`  提示: 单 token 天花板 = RPM/60（普通 0.5 rps / admin 10 rps）——429 出现即配额限速，聚合测容量请多 token`);
console.log('');

let pgTimer = null;
if (PG_SAMPLE) {
  pgTimer = setInterval(samplePgOnce, 1000);
  await samplePgOnce();
}

try {
  if (WARMUP_SECONDS > 0) {
    console.log(`[warmup] 单并发预热 ${WARMUP_SECONDS}s...`);
    await runStep(1, WARMUP_SECONDS, { quiet: true });
  }
  const results = [];
  for (const c of STEPS) {
    results.push(await runStep(c, STEP_SECONDS));
  }

  // 汇总：容量拐点 = 相邻档 RPS 增益 < 10% 的首档（错误率 <1% 的档）
  console.log('');
  console.log('── 汇总 ──');
  let sustainable = null;
  for (const r of results) {
    if (r.errCount / Math.max(r.total, 1) < 0.01 && (sustainable === null || r.rps > sustainable.rps)) sustainable = r;
  }
  if (sustainable) {
    console.log(`  可持续峰值（错误率<1% 的最高档）: ~${sustainable.rps.toFixed(1)} rps @ 并发${sustainable.concurrency}，p95=${fmtMs(sustainable.p95)}`);
  } else {
    console.log('  所有档错误率均 ≥1%——检查 token/配额/目标可用性');
  }
  const q429All = results.reduce((a, r) => a + r.q429, 0);
  if (q429All > 0) console.log(`  ⚠ 共 ${q429All} 次 429：配额在限速，上述 RPS 是配额上限而非服务容量——请提额或换 admin token 后重测`);

  // 跨机器外推：cpu-ms/req 在各档应基本稳定；不稳定取低并发档（未饱和、无排队开销）为服务需求
  if (CPU_PIDS.length > 0) {
    const stable = results.filter((r) => Object.keys(r.cpuMsPerReq).length > 0 && r.errCount / Math.max(r.total, 1) < 0.01);
    const ref = stable.find((r) => r.concurrency <= 2) || stable[0];
    if (ref) {
      console.log('  ── 服务器外推（机器无关指标）──');
      for (const [label, ms] of Object.entries(ref.cpuMsPerReq)) {
        console.log(`     ${label}: ${ms.toFixed(1)} cpu-ms/req（低并发基准档 c=${ref.concurrency}）`);
      }
      if (ref.singleCoreRps !== null) {
        console.log(`     单核等效: ~${ref.singleCoreRps.toFixed(0)} rps/核`);
        for (const cores of [1, 2, 4]) {
          console.log(`     ${cores} 核估算: ~${Math.round(ref.singleCoreRps * cores * 0.8)} rps（×0.8 并行效率折扣）`);
        }
      }
      console.log('     注: DB 连接池(pg)与内存是独立硬顶，CPU 外推不能超越它们；生产池上限见 compose 的 POOL 配置');
    }
  }
  if (PG_SAMPLE) {
    if (pgSamples > 0) console.log(`  pg 连接数峰值: ${pgPeak}（采样 ${pgSamples} 次）`);
    else if (!pgBroken) console.log('  pg 采样未取到数据');
  }
  console.log('  高性能开发机绝对 RPS 偏乐观——cpu-ms/req 可迁移；绝对容量用 docker-compose.loadtest.yml 限 1 核再跑一轮取保守值');
} finally {
  if (pgTimer) clearInterval(pgTimer);
}
