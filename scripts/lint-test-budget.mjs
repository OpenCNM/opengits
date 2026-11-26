/**
 * Test Budget Linter (Testing Governance Gate)
 *
 * Enforces repository-wide test slimming invariants:
 *   1. `tests/unit/**\/*.test.ts` file count <= 45
 *   2. Total unit test cases (`vitest list tests/unit --json`) <= 500
 *   3. `vi.mock(` calls across `tests/unit/**\/*.test.ts`, `tests/integration/**\/*.test.ts`,
 *      and `tests/golden/**\/*.{ts,mts,mjs,js}` == 0 repo-wide
 *   4. `*.each(` / `*.for(` (`it.each`, `it.for`, `test.each`, `test.for`, `describe.each`, `describe.for`)
 *      calls in `tests/unit/**\/*.test.ts` == 0
 *   5. `apps/client/tests/` must contain 0 test files (no stray unconfigured tests)
 *   6. `tests/golden/` must exist and every `tests/golden/<suite>/` must have >= 1 valid case (input.* + expected.*)
 *
 * Usage:
 *   node scripts/lint-test-budget.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = path.join(ROOT, 'tests', 'unit');
const INTEGRATION_DIR = path.join(ROOT, 'tests', 'integration');
const CLIENT_TESTS_DIR = path.join(ROOT, 'apps', 'client', 'tests');
const GOLDEN_DIR = path.join(ROOT, 'tests', 'golden');
const LOCAL_VITEST = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vitest.cmd' : 'vitest',
);

const MAX_UNIT_TEST_FILES = 45;
const MAX_UNIT_TEST_CASES = 500;
const MAX_VI_MOCK_FILES = 0;
const MAX_MATRIX_EXPANSION_FILES = 0;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const GOLDEN_SCRIPT_RE = /\.(?:ts|mts|mjs|js)$/;
const MATRIX_RECEIVERS = new Set(['it', 'test', 'describe']);
const MATRIX_METHODS = new Set(['each', 'for']);
const INPUT_RE = /^input\.[^.]+$/;
const EXPECTED_RE = /^expected\.[^.]+$/;
const RUNNER_CANDIDATES = ['run.ts', 'run.mts', 'run.mjs', 'run.js'];

function walkFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, predicate, out);
    } else if (entry.isFile() && predicate(entry.name, full)) {
      out.push(full);
    }
  }
  return out;
}

function listVitestUnitCases() {
  const useLocal = fs.existsSync(LOCAL_VITEST);
  const cmd = useLocal ? LOCAL_VITEST : 'npx';
  const args = useLocal
    ? ['list', 'tests/unit', '--json']
    : ['vitest', 'list', 'tests/unit', '--json'];

  const raw = execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true',
    },
  });

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Unexpected vitest list --json output (expected array)');
  }
  return parsed;
}

/**
 * Scan non-comment, non-string tokens via TypeScript's lexical scanner to detect
 * `vi.mock(...)` and `{it,test,describe}.{each,for}(...)` calls without false positives on comments.
 */
function scanTestCalls(content) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, content);
  const window = [];
  let hasViMock = false;
  let hasMatrixExpansion = false;

  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    const text = scanner.getTokenText();
    window.push({ kind, text });
    if (window.length > 4) window.shift();

    if (
      window.length === 4 &&
      window[1].kind === ts.SyntaxKind.DotToken &&
      window[3].kind === ts.SyntaxKind.OpenParenToken
    ) {
      const receiver = window[0].text;
      const method = window[2].text;
      if (receiver === 'vi' && method === 'mock') {
        hasViMock = true;
      }
      if (MATRIX_RECEIVERS.has(receiver) && MATRIX_METHODS.has(method)) {
        hasMatrixExpansion = true;
      }
    }

    kind = scanner.scan();
  }

  return { hasViMock, hasMatrixExpansion };
}

function main() {
  let violations = 0;

  console.log('\n🧪 [Test Budget Linter] Checking repository test limits...');

  const unitTestFiles = walkFiles(UNIT_DIR, (name) => name.endsWith('.test.ts')).sort();
  const integrationTestFiles = walkFiles(INTEGRATION_DIR, (name) => name.endsWith('.test.ts')).sort();
  const goldenScriptFiles = walkFiles(GOLDEN_DIR, (name) => GOLDEN_SCRIPT_RE.test(name)).sort();

  // 1. tests/unit/**/*.test.ts file count
  const unitCountOk = unitTestFiles.length <= MAX_UNIT_TEST_FILES;
  console.log(
    `   ${unitCountOk ? '✅' : '❌'} tests/unit/*.test.ts files: ${unitTestFiles.length} / ${MAX_UNIT_TEST_FILES}`,
  );
  if (!unitCountOk) violations++;

  // 2. Actual Vitest unit test cases (catches it.for / it.each expansions)
  let unitCases = [];
  let caseCountOk = false;
  try {
    unitCases = listVitestUnitCases();
    caseCountOk = unitCases.length <= MAX_UNIT_TEST_CASES;
    console.log(
      `   ${caseCountOk ? '✅' : '❌'} tests/unit test cases: ${unitCases.length} / ${MAX_UNIT_TEST_CASES}`,
    );
    if (!caseCountOk) {
      violations++;
      const perFile = new Map();
      for (const tc of unitCases) {
        const rel = tc.file ? path.relative(ROOT, tc.file).replace(/\\/g, '/') : '<unknown>';
        perFile.set(rel, (perFile.get(rel) || 0) + 1);
      }
      const topFiles = [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      for (const [rel, count] of topFiles) {
        console.error(`      - ${rel}: ${count} case(s)`);
      }
    }
  } catch (err) {
    violations++;
    console.error(
      `   ❌ tests/unit test cases: failed to run vitest list (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // 3. Repo-wide vi.mock( check across unit, integration, and golden
  const allRepoTestFiles = [...unitTestFiles, ...integrationTestFiles, ...goldenScriptFiles];
  const viMockFiles = [];
  const matrixFiles = [];
  const unitSet = new Set(unitTestFiles);

  for (const filePath of allRepoTestFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const { hasViMock, hasMatrixExpansion } = scanTestCalls(content);
    const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
    if (hasViMock) {
      viMockFiles.push(rel);
    }
    if (unitSet.has(filePath) && hasMatrixExpansion) {
      matrixFiles.push(rel);
    }
  }

  const viMockCountOk = viMockFiles.length <= MAX_VI_MOCK_FILES;
  console.log(
    `   ${viMockCountOk ? '✅' : '❌'} repo-wide test files with vi.mock(: ${viMockFiles.length} / ${MAX_VI_MOCK_FILES}`,
  );
  if (!viMockCountOk) {
    violations++;
    for (const rel of viMockFiles.slice(0, 10)) {
      console.error(`      - ${rel}`);
    }
    if (viMockFiles.length > 10) {
      console.error(`      ... and ${viMockFiles.length - 10} more`);
    }
  }

  // 4. Forbid *.each( / *.for( matrix expansion in tests/unit/**/*.test.ts
  const matrixOk = matrixFiles.length <= MAX_MATRIX_EXPANSION_FILES;
  console.log(
    `   ${matrixOk ? '✅' : '❌'} tests/unit/*.test.ts with *.each/*.for: ${matrixFiles.length} / ${MAX_MATRIX_EXPANSION_FILES}`,
  );
  if (!matrixOk) {
    violations++;
    for (const rel of matrixFiles) {
      console.error(`      - ${rel}`);
    }
  }

  // 5. apps/client/tests/ must contain 0 test files
  const strayClientTests = walkFiles(CLIENT_TESTS_DIR, (name) => TEST_FILE_RE.test(name))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))
    .sort();
  const clientTestsOk = strayClientTests.length === 0;

  console.log(
    `   ${clientTestsOk ? '✅' : '❌'} apps/client/tests/ stray test files: ${strayClientTests.length} / 0`,
  );
  if (!clientTestsOk) {
    violations++;
    for (const rel of strayClientTests) {
      console.error(`      - ${rel}`);
    }
  }

  // 6. Every tests/golden/<suite>/ must have >= 1 valid case (input.* + expected.*)
  const suites = fs.existsSync(GOLDEN_DIR)
    ? fs
        .readdirSync(GOLDEN_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
        .map((d) => d.name)
        .sort()
    : [];

  if (suites.length === 0) {
    console.log('   ❌ tests/golden/ suites: 0 (expected >= 1 suite)');
    violations++;
  } else {
    let goldenSuitesOk = true;
    const suiteDetails = [];

    for (const suiteName of suites) {
      const suiteDir = path.join(GOLDEN_DIR, suiteName);
      const hasRunner = RUNNER_CANDIDATES.some((c) => fs.existsSync(path.join(suiteDir, c)));
      const caseDirs = fs
        .readdirSync(suiteDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
        .map((d) => d.name)
        .sort();

      let validCases = 0;
      const invalidCases = [];
      for (const caseName of caseDirs) {
        const files = fs
          .readdirSync(path.join(suiteDir, caseName), { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name);
        const inputs = files.filter((n) => INPUT_RE.test(n));
        const expecteds = files.filter((n) => EXPECTED_RE.test(n));
        if (inputs.length === 1 && expecteds.length === 1) {
          validCases++;
        } else {
          invalidCases.push(`${caseName} (inputs=${inputs.length}, expected=${expecteds.length})`);
        }
      }

      const suiteOk = hasRunner && validCases >= 1 && invalidCases.length === 0;
      if (!suiteOk) {
        goldenSuitesOk = false;
        violations++;
      }
      suiteDetails.push({ suiteName, hasRunner, validCases, invalidCases, suiteOk });
    }

    console.log(
      `   ${goldenSuitesOk ? '✅' : '❌'} tests/golden/ suites (${suites.length}):`,
    );
    for (const s of suiteDetails) {
      console.log(
        `      ${s.suiteOk ? '✅' : '❌'} ${s.suiteName}: ${s.validCases} valid case(s), runner=${s.hasRunner}`,
      );
      for (const bad of s.invalidCases) {
        console.error(`         invalid case: ${bad}`);
      }
    }
  }

  console.log('--------------------------------------------------');
  if (violations > 0) {
    console.error(`💥 [Test Budget FAIL] ${violations} budget rule(s) violated.`);
    process.exit(1);
  }

  console.log('✅ [Test Budget PASS] All test budget limits satisfied.');
  process.exit(0);
}

main();
