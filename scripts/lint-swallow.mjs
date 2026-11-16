/**
 * 静默吞错门禁 (Silent Swallow Linter) — SWALLOW-001 / SWALLOW-002
 *
 * 宪章"失效封闭高于伪弹性"的 charter-as-code 执行器：
 * - SWALLOW-001: try/catch 块既不 rethrow、不向调用方传播错误、无日志、无承认注释
 *   （兜底/降级/容错/fail-open 词汇表）、也不属于良性惯用法白名单，即为违例。
 * - SWALLOW-002: promise 风格 .catch(() => null/[]/{}/undefined/false/'')——把错误静默
 *   折叠为"未找到/空集"语义（如 prisma 查询 DB 错误被伪装成 not-found）。
 *
 * 检测引擎：TypeScript Compiler API AST 遍历（宪章 Chomsky 边界——catch 块为嵌套配对结构，禁止正则扫描）。
 * 家族约定沿用 lint-anti-hardcode：🔍 头 / ❌ 违例 / ⚠️ 存量 / 💥 fail / ✅ pass；exit 1 on 新增。
 *
 * 棘轮基线：scripts/swallow-baseline.json 登记存量站点（只减不增，清偿即删条目，diff 可评审）。
 * 新增吞错站点 → fail；基线内存量站点 → ⚠️ 提示不阻断。
 *
 * 用法：
 *   node scripts/lint-swallow.mjs            # 校验（CI/verify 链）
 *   node scripts/lint-swallow.mjs --write    # 将当前站点全量写入基线（仅清偿后收缩基线时使用）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = path.join(ROOT, 'apps/client/src');
const BASELINE_FILE = path.join(ROOT, 'scripts/swallow-baseline.json');
const RULE_ID = 'SWALLOW-001';

// ─── 判定词汇表与白名单 ─────────────────────────────────────────

/** 承认注释词汇表（B 类）：说明"为何此降级安全"的既有惯用语，法规化为放行条件 */
const ACK_COMMENT_RE =
  /兜底|降级|容错|不阻断|fail-open|fail-closed|客户端断开|client.?disconnect|心跳|探测失败|可忽略|非关键路径/;

/** 错误传播特征（C 类）：向调用方/UI 交代了失败 */
const ERROR_PROPAGATION_RE =
  /NextResponse\.json|\.message\b|error:|reason:|throw new|enqueue.*error|reportError|captureException|traceError|onError|setError/;

/** 日志承认（B 类）：至少留下了痕迹 */
const LOG_ACK_RE = /console\.(warn|error)|logger\.(warn|error)|console\.info.*失败/;

/** 良性惯用法白名单：try 语句文本命中即放行（浏览器存储/URL 解码/流清理等机械降级） */
const BENIGN_IDIOMS = [
  /decodeURIComponent/,
  /sessionStorage\./,
  /localStorage\./,
  /\.setItem\(/,
  /\.removeItem\(/,
  /controller\.close\(/,
  /EventSource/,
  /readableStream|ReadableStream/,
  /matchMedia\b/,
];

// ─── 文件发现 ──────────────────────────────────────────────────

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

// ─── Catch 块判定 ──────────────────────────────────────────────

/** 微型注释扫描器：跳过字符串/模板字面量后提取 // 与 /* *\/ 注释（避免把字符串里的词误判为承认注释） */
function commentsIn(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '`' || c === '"') {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const start = i;
      while (i < text.length && text[i] !== '\n') i++;
      chunks.push(text.slice(start, i));
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      chunks.push(text.slice(start, Math.min(i, text.length)));
      continue;
    }
    i++;
  }
  return chunks.join('\n');
}

function classifyCatch(sourceFile, catchClause) {
  const sourceText = sourceFile.getFullText();
  const bodyText = catchClause.block.getText(sourceFile);
  // catch 子句全文（含关键字前 leading trivia 注释与块内注释）
  const fullText = sourceText.slice(catchClause.pos, catchClause.end);
  const comments = commentsIn(fullText);

  // 豁免标记（家族约定：行级 lint-ignore）
  if (comments.includes(`lint-ignore: SWALLOW-001`)) return 'EXEMPT';

  // 1. rethrow（含块内任意深度）
  if (/\bthrow\b/.test(bodyText)) return 'PASS_THROW';

  // 2. 错误传播特征（块内）
  if (ERROR_PROPAGATION_RE.test(bodyText)) return 'PASS_PROPAGATE';

  // 3. 日志承认
  if (LOG_ACK_RE.test(bodyText)) return 'PASS_LOG';

  // 4. 承认注释（catch 范围内注释区）
  if (ACK_COMMENT_RE.test(comments)) return 'PASS_ACK';

  // 5. 良性惯用法（try 块文本）
  const tryText = catchClause.parent ? catchClause.parent.getText(sourceFile) : '';
  if (BENIGN_IDIOMS.some((re) => re.test(tryText))) return 'PASS_IDIOM';

  return 'VIOLATION';
}

// ─── SWALLOW-002: promise 风格 .catch(() => 空值) 判定 ───────────

/** 判定 handler 表达式是否为"空值"（错误被折叠为 not-found/空集语义） */
function isEmptyValueNode(node, sourceFile) {
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

function isPromiseCatchCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'catch' &&
    node.arguments.length >= 1 &&
    (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
  );
}

/**
 * SWALLOW-002 判定：.catch(handler) 把 rejection 静默折叠为空值。
 * 放行条件与 SWALLOW-001 同构：rethrow / 错误传播 / 日志 / 承认注释 / 豁免标记 / 良性惯用法。
 * 仅命中"返回空值或空体"的 handler——返回真实回退值（对象/字符串等）不在 v1 范围。
 */
function classifyPromiseCatch(sourceFile, callExpr, enclosingStmt) {
  const sourceText = sourceFile.getFullText();
  const handler = callExpr.arguments[0];
  const handlerText = handler.getText(sourceFile);

  // 注释范围：整条语句（含 leading trivia）到 .catch 调用结束
  const commentStart = enclosingStmt ? enclosingStmt.pos : callExpr.pos;
  const comments = commentsIn(sourceText.slice(commentStart, callExpr.end));

  if (comments.includes('lint-ignore: SWALLOW-002')) return 'EXEMPT';

  if (/\bthrow\b/.test(handlerText)) return 'PASS_THROW';
  if (ERROR_PROPAGATION_RE.test(handlerText)) return 'PASS_PROPAGATE';
  if (LOG_ACK_RE.test(handlerText)) return 'PASS_LOG';
  if (ACK_COMMENT_RE.test(comments)) return 'PASS_ACK';

  const chainText = enclosingStmt ? enclosingStmt.getText(sourceFile) : handlerText;
  if (BENIGN_IDIOMS.some((re) => re.test(chainText))) return 'PASS_IDIOM';

  // 空值判定：箭头表达式体，或块体（空 / 仅一条空值 return）
  const body = handler.body;
  let emptySwallow = false;
  if (ts.isBlock(body)) {
    const stmts = body.statements;
    emptySwallow =
      stmts.length === 0 ||
      (stmts.length === 1 && ts.isReturnStatement(stmts[0]) && isEmptyValueNode(stmts[0].expression, sourceFile));
  } else {
    emptySwallow = isEmptyValueNode(body, sourceFile);
  }

  return emptySwallow ? 'VIOLATION' : 'PASS_VALUE';
}

// ─── 主流程 ────────────────────────────────────────────────────

function main() {
  const writeMode = process.argv.includes('--write');
  const files = walk(SCAN_ROOT);

  console.log(`\n🔍 [Silent-Swallow Linter] Scanning ${files.length} files (AST catch-clause analysis) ...`);

  const violations = []; // { rule, rel, line, code }
  for (const file of files) {
    const sourceText = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const rel = path.relative(ROOT, file).split(path.sep).join('/');

    // 父链栈：为 promise-catch 定位最近的语句级祖先（注释上下文范围）
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
      } else if (isPromiseCatchCall(node)) {
        // 找最近语句祖先（含其 leading trivia 注释）
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

  // 基线棘轮
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

  // 多重集棘轮：键 = "rel :: catch行文本"。行号漂移（上游插入/删除行）不再产生假新违例；
  // 同文件同文本的重复吞错按基线数量精确豁免，超出部分判新增。
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
        : '静默吞错：catch 既不抛出也不传播错误，且无日志/承认注释/白名单匹配。';
    console.error(`❌ [${v.rule}] ${v.rel}:${v.line} - ${desc}`);
    console.error(`   > ${v.code}`);
    console.error(`     修复：rethrow / 返回错误值 / console.warn + "// 容错降级: <原因>" 注释 / "// lint-ignore: ${v.rule}" 豁免。`);
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
