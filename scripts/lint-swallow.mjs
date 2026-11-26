/**
 * 静默吞错门禁 (Silent Swallow Linter) — SWALLOW-001 / SWALLOW-002
 *
 * 宪章"失效封闭高于伪弹性"执行器（Chomsky 边界：基于 TypeScript AST 判定嵌套 catch 与链式调用）：
 * - SWALLOW-001: try/catch 既不抛出、不传播错误、不返回非空回退值、无日志、无 ignoreBestEffort，也不命中良性惯用法。
 * - SWALLOW-002: Promise .catch(...) 把 rejection 静默折叠为空值（null/undefined/[]/{}/false/''/0）或空体。
 *
 * 棘轮基线：scripts/swallow-baseline.json 登记存量站点（只减不增），新增吞错直接阻断。
 *
 * 用法：
 *   node scripts/lint-swallow.mjs            # 校验（CI/verify 链）
 *   node scripts/lint-swallow.mjs --write    # 清偿后收缩基线
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = path.join(ROOT, 'apps/client/src');
const BASELINE_FILE = path.join(ROOT, 'scripts/swallow-baseline.json');

const ERROR_PROPAGATION_RE =
  /NextResponse\.json|\.message\b|error:|reason:|throw new|enqueue.*error|reportError|captureException|traceError|onError|setError/;

const LOG_ACK_RE = /console\.(warn|error)|logger\.(warn|error)|console\.info.*失败/;

// Zod schema `.catch(fallback)` shares method name with Promise.prototype.catch but defines parser defaults.
const ZOD_SCHEMA_CHAIN_RE = /\bz\s*\.|\.(?:boolean|string|number|array|object|enum|record|optional|nullable)\s*\(/;

const BENIGN_IDIOMS = [
  /decodeURIComponent/,
  /sessionStorage\./,
  /localStorage\./,
  /\.setItem\(/,
  /\.removeItem\(/,
  /controller\.close\(/,
  /controller\.enqueue\(/,
  /writer\.write\(/,
  /writer\.close\(/,
  /writer\.abort\(/,
  /reader\.cancel\(/,
  /releasePointerCapture\(/,
  /navigator\.share\(/,
  /navigator\.clipboard/,
  /PerformanceObserver/,
  /EventSource/,
  /readableStream|ReadableStream/,
  /matchMedia\b/,
  /\breq\.json\(/,
  /\bres\.json\(/,
  /\brequest\.json\(/,
  /\bresponse\.json\(/,
  /\breadBodyJson\(/,
  /\bres\.text\(/,
  /\bJSON\.parse\(/,
  /\bnew URL\(/,
  /\.abort\(/,
  /fs\.unlink|fs\.rm\(|fs\.remove\(|fs\.stat\(|fs\.readdir\(/,
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function isEmptyValueNode(node) {
  let n = node;
  while (n && ts.isParenthesizedExpression(n)) n = n.expression;
  if (!n) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(n) && n.text === 'undefined') return true;
  if (ts.isArrayLiteralExpression(n) && n.elements.length === 0) return true;
  if (ts.isObjectLiteralExpression(n) && n.properties.length === 0) return true;
  if (ts.isBooleanLiteral(n) && n.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isStringLiteral(n) && n.text === '') return true;
  if (n.kind === ts.SyntaxKind.NumericLiteral && String(n.text) === '0') return true;
  return false;
}

function classifyCatch(sourceFile, catchClause) {
  const bodyText = catchClause.block.getText(sourceFile);

  if (/\bthrow\b/.test(bodyText)) return 'PASS_THROW';
  if (ERROR_PROPAGATION_RE.test(bodyText)) return 'PASS_PROPAGATE';
  if (LOG_ACK_RE.test(bodyText)) return 'PASS_LOG';
  if (/\bignoreBestEffort\b/.test(bodyText)) return 'PASS_BEST_EFFORT';
  if (
    catchClause.block.statements.some(
      (st) => ts.isReturnStatement(st) && st.expression && !isEmptyValueNode(st.expression)
    )
  ) {
    return 'PASS_RETURN';
  }

  const tryText = catchClause.parent ? catchClause.parent.getText(sourceFile) : '';
  if (BENIGN_IDIOMS.some((re) => re.test(tryText))) return 'PASS_IDIOM';

  return 'VIOLATION';
}

function isPromiseCatchCall(node, sourceFile) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== 'catch' ||
    node.arguments.length < 1
  ) {
    return false;
  }

  const receiverText = node.expression.expression.getText(sourceFile);
  if (ZOD_SCHEMA_CHAIN_RE.test(receiverText)) return false;

  const arg = node.arguments[0];
  return (
    ts.isArrowFunction(arg) ||
    ts.isFunctionExpression(arg) ||
    (ts.isIdentifier(arg) && arg.text === 'ignoreBestEffort')
  );
}

function classifyPromiseCatch(sourceFile, callExpr, enclosingStmt) {
  const handler = callExpr.arguments[0];
  if (ts.isIdentifier(handler) && handler.text === 'ignoreBestEffort') {
    return 'PASS_BEST_EFFORT';
  }

  const handlerText = handler.getText(sourceFile);
  if (/\bignoreBestEffort\b/.test(handlerText)) return 'PASS_BEST_EFFORT';
  if (/\bthrow\b/.test(handlerText)) return 'PASS_THROW';
  if (ERROR_PROPAGATION_RE.test(handlerText)) return 'PASS_PROPAGATE';
  if (LOG_ACK_RE.test(handlerText)) return 'PASS_LOG';

  const chainText = enclosingStmt ? enclosingStmt.getText(sourceFile) : handlerText;
  if (BENIGN_IDIOMS.some((re) => re.test(chainText))) return 'PASS_IDIOM';

  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) {
    return 'PASS_VALUE';
  }

  const body = handler.body;
  let emptySwallow = false;
  if (ts.isBlock(body)) {
    const stmts = body.statements;
    emptySwallow =
      stmts.length === 0 ||
      (stmts.length === 1 && ts.isReturnStatement(stmts[0]) && isEmptyValueNode(stmts[0].expression));
  } else {
    emptySwallow = isEmptyValueNode(body);
  }

  return emptySwallow ? 'VIOLATION' : 'PASS_VALUE';
}

function main() {
  const writeMode = process.argv.includes('--write');
  const files = walk(SCAN_ROOT);

  console.log(`\n🔍 [Silent-Swallow Linter] Scanning ${files.length} files (AST catch-clause analysis) ...`);

  const violations = [];
  for (const file of files) {
    const sourceText = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ESNext, true);
    const rel = path.relative(ROOT, file).split(path.sep).join('/');

    // Track nearest statement ancestor so BENIGN_IDIOMS can inspect the full chained call.
    const parentStack = [];
    const visit = (node) => {
      parentStack.push(node);

      if (ts.isCatchClause(node)) {
        const kind = classifyCatch(sourceFile, node);
        if (kind === 'VIOLATION') {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const lineText = sourceText.split('\n')[line].trim();
          violations.push({ rule: 'SWALLOW-001', rel, line: line + 1, code: lineText });
        }
      } else if (isPromiseCatchCall(node, sourceFile)) {
        let stmt = null;
        for (let i = parentStack.length - 1; i >= 0; i--) {
          if (ts.isStatement(parentStack[i])) {
            stmt = parentStack[i];
            break;
          }
        }
        const kind = classifyPromiseCatch(sourceFile, node, stmt);
        if (kind === 'VIOLATION') {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const lineText = sourceText.split('\n')[line].trim();
          violations.push({ rule: 'SWALLOW-002', rel, line: line + 1, code: lineText });
        }
      }

      ts.forEachChild(node, visit);
      parentStack.pop();
    };
    visit(sourceFile);
  }
  violations.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);

  let baseline = [];
  if (fs.existsSync(BASELINE_FILE)) {
    baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  }

  if (writeMode) {
    fs.writeFileSync(
      BASELINE_FILE,
      JSON.stringify(
        violations.map((v) => `${v.rel} :: ${v.code}`),
        null,
        2
      ) + '\n'
    );
    console.log(`📝 基线已写入: ${violations.length} 个存量站点（键: 文件+catch行文本，行号漂移免疫）→ ${path.relative(ROOT, BASELINE_FILE)}`);
    process.exit(0);
  }

  // Multiset ratchet keyed by "rel :: code" tolerates line-number shifts while bounding duplicate sites.
  const keyOf = (v) => `${v.rel} :: ${v.code}`;
  const baselineCounts = new Map();
  for (const entry of baseline) {
    baselineCounts.set(entry, (baselineCounts.get(entry) ?? 0) + 1);
  }
  const fresh = [];
  let legacyCount = 0;
  for (const v of violations) {
    const key = keyOf(v);
    const remaining = baselineCounts.get(key) ?? 0;
    if (remaining > 0) {
      baselineCounts.set(key, remaining - 1);
      legacyCount++;
    } else {
      fresh.push(v);
    }
  }
  const legacy = { length: legacyCount };

  for (const v of fresh) {
    const desc =
      v.rule === 'SWALLOW-002'
        ? 'promise 静默吞错：.catch 把 rejection 折叠为空值（null/[]/{}/false），DB/网络错误被伪装成"未找到/空集"。'
        : '静默吞错：catch 既不抛出也不传播/返回错误值，且无日志/ignoreBestEffort/白名单匹配。';
    console.error(`❌ [${v.rule}] ${v.rel}:${v.line} - ${desc}`);
    console.error(`   > ${v.code}`);
    console.error(`     修复：rethrow / 返回非空回退值 / console.warn|error / 调用 ignoreBestEffort。`);
  }
  if (legacy.length > 0) {
    console.log(`⚠️  存量待偿 ${legacy.length} 处（明细见 swallow-baseline.json，清偿后请删除条目）`);
  }

  console.log('--------------------------------------------------');
  if (fresh.length > 0) {
    console.error(`💥 Silent-Swallow Linter failed: ${fresh.length} 个新增静默吞错站点（存量 ${legacy.length} 处已登记）。`);
    process.exit(1);
  }
  console.log(`✅ Silent-Swallow Linter passed: 0 新增吞错；存量登记 ${legacy.length} 处（只减不增）。`);
}

main();
