/**
 * Golden Diff Runner (Zero External Dependencies)
 *
 * Scans `tests/golden/<suite>/<case>/` where each case has:
 *   - `input.*` (e.g. input.md, input.ts, input.json)
 *   - `expected.*` (e.g. expected.txt, expected.json, expected.mdx)
 *
 * Each suite directory `tests/golden/<suite>/` provides a runner module:
 *   `run.ts` | `run.mts` | `run.mjs` | `run.js`
 * Exporting `default` or `run(input: string, ctx: GoldenCaseContext): string | Promise<string>`.
 *
 * Usage:
 *   node scripts/run-golden-diff.mjs [--suite <name>] [--case <name>] [--update]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_ROOT = path.join(ROOT, 'tests', 'golden');
const RUNNER_CANDIDATES = ['run.ts', 'run.mts', 'run.mjs', 'run.js'];
const INPUT_RE = /^input\.[^.]+$/;
const EXPECTED_RE = /^expected\.[^.]+$/;

function parseArgs(argv) {
  const suites = new Set();
  const cases = new Set();
  let update = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--update' || arg === '-u') {
      update = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--suite' || arg === '-s') {
      const next = argv[++i];
      if (!next) {
        throw new Error(`Missing value after ${arg}`);
      }
      for (const s of next.split(',').map((v) => v.trim()).filter(Boolean)) {
        suites.add(s);
      }
    } else if (arg.startsWith('--suite=')) {
      const val = arg.slice('--suite='.length);
      for (const s of val.split(',').map((v) => v.trim()).filter(Boolean)) {
        suites.add(s);
      }
    } else if (arg === '--case' || arg === '-c') {
      const next = argv[++i];
      if (!next) {
        throw new Error(`Missing value after ${arg}`);
      }
      for (const c of next.split(',').map((v) => v.trim()).filter(Boolean)) {
        cases.add(c);
      }
    } else if (arg.startsWith('--case=')) {
      const val = arg.slice('--case='.length);
      for (const c of val.split(',').map((v) => v.trim()).filter(Boolean)) {
        cases.add(c);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { suites, cases, update, help };
}

function printHelp() {
  console.log(
    [
      'Usage: node scripts/run-golden-diff.mjs [options]',
      '',
      'Options:',
      '  --suite <name>   Run only matching suite(s) (repeatable or comma-separated)',
      '  --case <name>    Run only matching case(s) (repeatable or comma-separated)',
      '  --update, -u     Overwrite (or create) expected.* with actual output',
      '  --help, -h       Show this help',
    ].join('\n'),
  );
}

let cachedTsImport = null;
async function loadModule(filePath) {
  const ext = path.extname(filePath);
  const fileUrl = pathToFileURL(filePath).href;
  if (ext === '.ts' || ext === '.mts') {
    if (!cachedTsImport) {
      const tsxApi = await import('tsx/esm/api');
      cachedTsImport = tsxApi.tsImport;
    }
    return cachedTsImport(fileUrl, import.meta.url);
  }
  return import(fileUrl);
}

function splitLines(text) {
  if (text === '') return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith('\n');
  const raw = trailingNewline ? text.slice(0, -1) : text;
  return { lines: raw.split('\n'), trailingNewline };
}

/**
 * Pure-JS unified line diff with common prefix/suffix trimming and LCS over the middle slice.
 */
function formatUnifiedDiff(expectedLabel, actualLabel, expectedText, actualText, contextLines = 3) {
  const exp = splitLines(expectedText);
  const act = splitLines(actualText);

  let prefix = 0;
  while (
    prefix < exp.lines.length &&
    prefix < act.lines.length &&
    exp.lines[prefix] === act.lines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < exp.lines.length - prefix &&
    suffix < act.lines.length - prefix &&
    exp.lines[exp.lines.length - 1 - suffix] === act.lines[act.lines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const expMid = exp.lines.slice(prefix, exp.lines.length - suffix);
  const actMid = act.lines.slice(prefix, act.lines.length - suffix);

  const ops = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ type: ' ', line: exp.lines[i] });
  }

  const m = expMid.length;
  const n = actMid.length;

  // Guard against quadratic memory on huge multi-thousand-line diffs
  if (m * n > 2_500_000) {
    for (const line of expMid) ops.push({ type: '-', line });
    for (const line of actMid) ops.push({ type: '+', line });
  } else {
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (expMid[i] === actMid[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (expMid[i] === actMid[j]) {
        ops.push({ type: ' ', line: expMid[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: '-', line: expMid[i] });
        i++;
      } else {
        ops.push({ type: '+', line: actMid[j] });
        j++;
      }
    }
    while (i < m) ops.push({ type: '-', line: expMid[i++] });
    while (j < n) ops.push({ type: '+', line: actMid[j++] });
  }

  for (let i = exp.lines.length - suffix; i < exp.lines.length; i++) {
    ops.push({ type: ' ', line: exp.lines[i] });
  }

  const changeIndices = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type !== ' ') changeIndices.push(idx);
  }

  const out = [`--- ${expectedLabel}`, `+++ ${actualLabel}`];

  if (changeIndices.length === 0) {
    if (exp.trailingNewline !== act.trailingNewline) {
      out.push(
        `@@ trailing newline mismatch: expected=${exp.trailingNewline}, actual=${act.trailingNewline} @@`,
      );
    } else {
      out.push('@@ outputs differ (e.g. CRLF vs LF) @@');
    }
    return out.join('\n');
  }

  // Group nearby changes into hunks
  const hunks = [];
  let start = Math.max(0, changeIndices[0] - contextLines);
  let end = Math.min(ops.length - 1, changeIndices[0] + contextLines);

  for (let k = 1; k < changeIndices.length; k++) {
    const nextStart = Math.max(0, changeIndices[k] - contextLines);
    const nextEnd = Math.min(ops.length - 1, changeIndices[k] + contextLines);
    if (nextStart <= end + 1) {
      end = nextEnd;
    } else {
      hunks.push([start, end]);
      start = nextStart;
      end = nextEnd;
    }
  }
  hunks.push([start, end]);

  for (const [hStart, hEnd] of hunks) {
    let oldLine = 1;
    let newLine = 1;
    for (let idx = 0; idx < hStart; idx++) {
      if (ops[idx].type !== '+') oldLine++;
      if (ops[idx].type !== '-') newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    const body = [];
    for (let idx = hStart; idx <= hEnd; idx++) {
      const op = ops[idx];
      if (op.type !== '+') oldCount++;
      if (op.type !== '-') newCount++;
      body.push(`${op.type}${op.line}`);
    }
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    out.push(...body);
  }

  if (exp.trailingNewline !== act.trailingNewline) {
    out.push(
      `[newline] expected trailing newline=${exp.trailingNewline}, actual=${act.trailingNewline}`,
    );
  }

  return out.join('\n');
}

function discoverSuites(filterSuites) {
  if (!fs.existsSync(GOLDEN_ROOT)) {
    throw new Error(`Golden root directory not found: ${path.relative(ROOT, GOLDEN_ROOT)}`);
  }

  const allSuites = fs
    .readdirSync(GOLDEN_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();

  if (filterSuites.size === 0) {
    return allSuites;
  }

  for (const req of filterSuites) {
    if (!allSuites.includes(req)) {
      throw new Error(`Requested suite "${req}" not found under tests/golden/ (available: ${allSuites.join(', ') || 'none'})`);
    }
  }

  return allSuites.filter((name) => filterSuites.has(name));
}

function findRunner(suiteDir) {
  for (const candidate of RUNNER_CANDIDATES) {
    const full = path.join(suiteDir, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return full;
    }
  }
  return null;
}

function normalizeExt(ext) {
  if (!ext || typeof ext !== 'string') return '.txt';
  return ext.startsWith('.') ? ext : `.${ext}`;
}

async function runSuite(suiteName, { casesFilter, update }) {
  const suiteDir = path.join(GOLDEN_ROOT, suiteName);
  const runnerPath = findRunner(suiteDir);
  if (!runnerPath) {
    throw new Error(
      `Suite "${suiteName}" is missing a runner (${RUNNER_CANDIDATES.join(' | ')}) in tests/golden/${suiteName}/`,
    );
  }

  const mod = await loadModule(runnerPath);
  const runnerFn = typeof mod.default === 'function' ? mod.default : mod.run;
  if (typeof runnerFn !== 'function') {
    throw new Error(
      `Runner ${path.relative(ROOT, runnerPath)} must export default or named "run" function`,
    );
  }
  const defaultExpectedExt = normalizeExt(mod.defaultExt);

  const allCaseDirs = fs
    .readdirSync(suiteDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();

  if (allCaseDirs.length === 0) {
    throw new Error(`Suite "${suiteName}" has 0 case directories under tests/golden/${suiteName}/`);
  }

  const selectedCases =
    casesFilter.size > 0 ? allCaseDirs.filter((c) => casesFilter.has(c)) : allCaseDirs;

  const stats = { passed: 0, failed: 0, updated: 0 };

  for (const caseName of selectedCases) {
    const caseDir = path.join(suiteDir, caseName);
    const entries = fs.readdirSync(caseDir, { withFileTypes: true }).filter((e) => e.isFile());
    const inputs = entries.filter((e) => INPUT_RE.test(e.name)).map((e) => e.name);
    const expecteds = entries.filter((e) => EXPECTED_RE.test(e.name)).map((e) => e.name);

    const caseLabel = `${suiteName}/${caseName}`;

    if (inputs.length !== 1) {
      console.error(`❌ [FAIL] ${caseLabel}: expected exactly 1 input.* file, found ${inputs.length}`);
      stats.failed++;
      continue;
    }
    if (expecteds.length > 1) {
      console.error(`❌ [FAIL] ${caseLabel}: expected at most 1 expected.* file, found ${expecteds.length}`);
      stats.failed++;
      continue;
    }
    if (expecteds.length === 0 && !update) {
      console.error(`❌ [FAIL] ${caseLabel}: missing expected.* file (run with --update to generate)`);
      stats.failed++;
      continue;
    }

    const inputPath = path.join(caseDir, inputs[0]);
    const inputExt = path.extname(inputs[0]);
    const expectedPath = expecteds.length === 1 ? path.join(caseDir, expecteds[0]) : null;
    const expectedExt = expectedPath ? path.extname(expectedPath) : null;

    const inputText = fs.readFileSync(inputPath, 'utf8');

    let actual;
    try {
      actual = await runnerFn(inputText, {
        suite: suiteName,
        caseName,
        caseDir,
        inputPath,
        inputExt,
        expectedPath,
        expectedExt,
      });
    } catch (err) {
      console.error(`❌ [ERROR] ${caseLabel}: runner threw error:`);
      console.error(err instanceof Error ? err.stack || err.message : String(err));
      stats.failed++;
      continue;
    }

    if (typeof actual !== 'string') {
      console.error(`❌ [FAIL] ${caseLabel}: runner must return a string, got ${typeof actual}`);
      stats.failed++;
      continue;
    }

    if (!expectedPath) {
      const targetPath = path.join(caseDir, `expected${defaultExpectedExt}`);
      fs.writeFileSync(targetPath, actual, 'utf8');
      console.log(`📝 [CREATED] ${caseLabel} -> ${path.relative(ROOT, targetPath)}`);
      stats.updated++;
      continue;
    }

    const expectedText = fs.readFileSync(expectedPath, 'utf8');
    if (actual === expectedText) {
      stats.passed++;
      continue;
    }

    if (update) {
      fs.writeFileSync(expectedPath, actual, 'utf8');
      console.log(`📝 [UPDATED] ${caseLabel} -> ${path.relative(ROOT, expectedPath)}`);
      stats.updated++;
    } else {
      console.error(`❌ [DIFF] ${caseLabel}`);
      const relExpected = path.relative(ROOT, expectedPath);
      console.error(formatUnifiedDiff(relExpected, `${caseLabel} (actual)`, expectedText, actual));
      console.error('');
      stats.failed++;
    }
  }

  return stats;
}

async function main() {
  const { suites: suiteFilter, cases: casesFilter, update, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    process.exit(0);
  }

  const suites = discoverSuites(suiteFilter);
  if (suites.length === 0) {
    console.error('❌ [Golden Diff] No suites found under tests/golden/.');
    process.exit(1);
  }

  console.log(`\n🥇 [Golden Diff] Running ${suites.length} suite(s)${update ? ' (--update)' : ''}...`);

  let totalPassed = 0;
  let totalFailed = 0;
  let totalUpdated = 0;

  for (const suiteName of suites) {
    const res = await runSuite(suiteName, { casesFilter, update });
    totalPassed += res.passed;
    totalFailed += res.failed;
    totalUpdated += res.updated;
    const statusIcon = res.failed > 0 ? '❌' : '✅';
    console.log(
      `   ${statusIcon} ${suiteName}: ${res.passed} passed, ${res.updated} updated, ${res.failed} failed`,
    );
  }

  if (casesFilter.size > 0 && totalPassed + totalFailed + totalUpdated === 0) {
    console.error(`❌ [Golden Diff] No cases matched --case filter: ${[...casesFilter].join(', ')}`);
    process.exit(1);
  }

  console.log('--------------------------------------------------');
  if (totalFailed > 0) {
    console.error(
      `💥 [Golden Diff FAIL] ${totalFailed} failed, ${totalPassed} passed, ${totalUpdated} updated. Run "npm run test:golden:update" if changes are intentional.`,
    );
    process.exit(1);
  }

  console.log(
    `✅ [Golden Diff PASS] ${totalPassed} passed, ${totalUpdated} updated, 0 failed.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`💥 [Golden Diff ERROR] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
