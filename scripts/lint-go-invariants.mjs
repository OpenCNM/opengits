#!/usr/bin/env node
/**
 * scripts/lint-go-invariants.mjs
 *
 * Go 端物理不变式与安全守卫门禁（零依赖）：
 * 针对从 Node.js 下沉到 Go 进程过程中暴露的高频物理漏洞与降级盲区进行源码级静态审计。
 *
 * 规则清单：
 * 1. [GO-001] (Unbounded Stream Read / OOM 防护)：
 *    所有生产代码中的 io.ReadAll() 必须用 io.LimitReader() 包裹，杜绝无界读取外部输入导致 OOM。
 * 2. [GO-002] (Archive Directory Traversal / 路径穿越防护)：
 *    根据外部参数拼接 archiveRoot 本地归档路径的文件读取函数，必须包含 filepath.Rel 校验并拦截 ".." 前缀。
 * 3. [GO-003] (Advisory Lock Transaction Scope / 事务锁作用域)：
 *    pg_advisory_xact_lock 必须在显式事务上下文（tx / TxExec）中执行，禁止直接在连接池上调用。
 * 4. [GO-004] (Chomsky Boundary & High-Order Syntax Regex / AST 首要原则)：
 *    业务包（除 treesitter、mdpat、sanitize 以外）严禁用正则扫描代码高阶语法（如 import/func/class）。
 *    v2 收紧：转义写法（func\s、function\s*、type\s）同样命中——历史实现只匹配
 *    字面空格导致全部逃逸；仅显式标记 LINT-EXEMPT: code-syntax-regex-fallback
 *    的文件豁免（BUG-65 残留兜底专用，新增违例一律拒绝）。
 * 5. [GO-005] (Unbounded Context / Goroutine I/O Timeout 防护)：
 *    异步协程与外部 Store/Client/Lease 调用严禁裸用无界 context.Background()，必须设置 context.WithTimeout 超时上限。
 * 6. [GO-006] (Tx Scope Connection Leak / 连接池饥饿死锁防护)：
 *    接收 tx pgx.Tx 的函数体或 pgx.BeginFunc 闭包内，严禁调用 s.pool.Query/QueryRow/Exec——
 *    池满时事务等空闲连接、空闲连接等事务提交，形成确定性死锁。
 * 7. [GO-007] (HTML Structural Regex Ban / 结构性 HTML 正则禁入)：
 *    webdoc/sanitize 包严禁用正则匹配 HTML 标签结构（</tag>、<!--、<script 等
 *    配对/嵌套形态）——结构处理必须走 tagscan.go 确定性扫描器或 x/net/html。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GO_ROOT = path.join(ROOT_DIR, 'services', 'worker-sidecar');

// findFuncEnd 从函数签名行起找函数体结束行（首个顶层 "}"； brace 深度计法）
function findFuncEnd(lines, startIdx) {
  let depth = 0;
  let opened = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') { depth--; }
    }
    if (opened && depth <= 0) return i;
  }
  return Math.min(startIdx + 200, lines.length - 1);
}

function* walkGoFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === '.git' || entry.name === 'testdata') continue;
      yield* walkGoFiles(full);
    } else if (entry.name.endsWith('.go')) {
      yield full;
    }
  }
}

const violations = [];
let totalFiles = 0;
let prodFiles = 0;

for (const filePath of walkGoFiles(GO_ROOT)) {
  totalFiles++;
  const isTest = filePath.endsWith('_test.go');
  if (isTest) continue;
  prodFiles++;

  const relPath = path.relative(ROOT_DIR, filePath).split(path.sep).join('/');
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // -------------------------------------------------------------
  // GO-001: io.ReadAll 必须使用 io.LimitReader 限制上限
  // -------------------------------------------------------------
  lines.forEach((line, idx) => {
    // 排除单行注释
    if (/^\s*\/\//.test(line)) return;

    if (line.includes('io.ReadAll(')) {
      const isWrapped = line.includes('io.LimitReader') ||
                        line.includes('bytes.NewReader') ||
                        line.includes('strings.NewReader');
      if (!isWrapped) {
        violations.push({
          rule: 'GO-001',
          file: relPath,
          line: idx + 1,
          code: line.trim(),
          desc: '生产代码中的 io.ReadAll() 必须使用 io.LimitReader() 限制最大读取字节数，防止恶意响应或大文件导致 OOM。',
        });
      }
    }
  });

  // -------------------------------------------------------------
  // GO-002: 本地归档目录读取的路径穿越校验
  // -------------------------------------------------------------
  if (content.includes('func readLocalArchiveFile') && !content.includes('filepath.Rel')) {
    violations.push({
      rule: 'GO-002',
      file: relPath,
      line: 1,
      code: 'readLocalArchiveFile(...)',
      desc: '从本地解压归档读取文件时，未包含 filepath.Rel() 校验与 ".." 越界前缀拦截，存在路径穿越安全风险。',
    });
  }

  // -------------------------------------------------------------
  // GO-003: pg_advisory_xact_lock 必须由事务执行
  // -------------------------------------------------------------
  if (content.includes('pg_advisory_xact_lock')) {
    lines.forEach((line, idx) => {
      if (/^\s*\/\//.test(line)) return;
      if (/(?:s\.)?pool\.Exec\([^)]*pg_advisory_xact_lock/.test(line)) {
        violations.push({
          rule: 'GO-003',
          file: relPath,
          line: idx + 1,
          code: line.trim(),
          desc: 'pg_advisory_xact_lock 是事务级锁，脱离事务在连接池 pool 上调用会立即释放，锁失效！必须在 tx.Exec 中调用。',
        });
      }
    });
  }

  // -------------------------------------------------------------
  // GO-004 v2: 严禁在业务逻辑中用正则解析高阶代码语法 (import/class/func/def)
  // 转义感知：`func\s`、`function\s*`、`type\s` 等逃逸写法同样命中。
  // -------------------------------------------------------------
  const isSyntaxExempt = relPath.includes('/internal/treesitter/') ||
                         relPath.includes('/internal/mdpat/') ||
                         relPath.includes('/internal/sanitize/') ||
                         content.includes('LINT-EXEMPT: code-syntax-regex');
  if (!isSyntaxExempt) {
    lines.forEach((line, idx) => {
      if (/^\s*\/\//.test(line)) return;
      // 关键字后跟：真实空白 / \s \b 等转义 / 紧接 '(' —— 三种形态均为语法匹配
      if (/regexp\.MustCompile\(["'`][^"'`]*\b(?:import|function|func|class|def|interface|enum|struct|type)\s*(?:\\[snbwd+*]|\s|\()/i.test(line)) {
        violations.push({
          rule: 'GO-004',
          file: relPath,
          line: idx + 1,
          code: line.trim(),
          desc: '严禁使用正则提取代码语法符号（import/class/func/def/type 等，含 \\s 转义形态），高阶语法分析必须且只能依赖 Tree-sitter AST；存量兜底须以 LINT-EXEMPT: code-syntax-regex-fallback 显式标记并限定在 BUG-65 残留文件。',
        });
      }
    });
  }

  // -------------------------------------------------------------
  // GO-007: webdoc/sanitize 包严禁正则匹配 HTML 标签结构
  // （</tag> 配对、<!-- 注释、<script 等嵌套形态属 Chomsky 越界，
  //   结构处理走 tagscan.go 确定性扫描器或 x/net/html）
  // -------------------------------------------------------------
  if (relPath.includes('/internal/webdoc/') || relPath.includes('/internal/sanitize/')) {
    lines.forEach((line, idx) => {
      if (/^\s*\/\//.test(line)) return;
      if (/regexp\.MustCompile\(["'`][^"'`]*<\/?[a-zA-Z!]/.test(line)) {
        violations.push({
          rule: 'GO-007',
          file: relPath,
          line: idx + 1,
          code: line.trim(),
          desc: 'webdoc/sanitize 包禁止用正则匹配 HTML 标签结构（配对/嵌套形态）——必须走 tagscan.go 确定性扫描器或 x/net/html AST（Markdown 一维文本模式不受限）。',
        });
      }
    });
  }

  // -------------------------------------------------------------
  // GO-006: 事务作用域内严禁穿透全局连接池（饥饿死锁防护）
  // -------------------------------------------------------------
  // 识别两类事务作用域：a) 形参含 tx pgx.Tx 的函数体；b) pgx.BeginFunc 闭包。
  // 块内出现 s.pool.Query/QueryRow/Exec 即违规（读路径可用 s.pool 的只读副本
  // 方法除外——当前代码库不存在该形态，直接全禁）。
  {
    const txScopes = [];
    // a) 函数签名携带 tx pgx.Tx
    lines.forEach((line, idx) => {
      if (/func\s+(?:\([^)]*\)\s+)?[\w[\]]+\s*\([^)]*tx\s+pgx\.Tx/.test(line) || /\(tx\s+pgx\.Tx/.test(line)) {
        txScopes.push({ start: idx, end: findFuncEnd(lines, idx) });
      }
    });
    // b) pgx.BeginFunc 闭包
    lines.forEach((line, idx) => {
      if (/pgx\.BeginFunc\(/.test(line) && !txScopes.some((s) => s.start === idx)) {
        txScopes.push({ start: idx, end: findFuncEnd(lines, idx) });
      }
    });
    for (const scope of txScopes) {
      for (let i = scope.start; i <= scope.end && i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*\/\//.test(line)) continue;
        if (/\bs\.pool\.(Query|QueryRow|Exec)\s*\(/.test(line)) {
          violations.push({
            rule: 'GO-006',
            file: relPath,
            line: i + 1,
            code: line.trim(),
            desc: '事务作用域（tx pgx.Tx / pgx.BeginFunc 闭包）内调用全局连接池 s.pool.*：池满时事务与池互等形成确定性饥饿死锁，必须改用 tx.*。',
          });
        }
      }
    }
  }

  // -------------------------------------------------------------
  // GO-005: 外部 Store/Client/Lease 调用严禁裸传无界 context.Background()
  // -------------------------------------------------------------
  lines.forEach((line, idx) => {
    if (/^\s*\/\//.test(line)) return;
    if (/(?:store|client|webClient|autoWebClient|s\.store|r\.store|currentStore)\.[A-Z]\w*\([^)]*context\.Background\(\)/.test(line) ||
        /(?:releaseLease|acquireLease)\([^)]*context\.Background\(\)/.test(line)) {
      violations.push({
        rule: 'GO-005',
        file: relPath,
        line: idx + 1,
        code: line.trim(),
        desc: '调用外部 Store/Client 或租约方法时裸用无界 context.Background()，必须使用 context.WithTimeout 设置确定性超时上限。',
      });
    }
  });
}

console.log(`\n🔍 [Go Invariant Linter] 扫描完成：共检查 ${totalFiles} 个 Go 文件（生产代码 ${prodFiles} 个）。`);

if (violations.length > 0) {
  console.error(`\n❌ 发现 ${violations.length} 处 Go 物理不变式违规：\n`);
  for (const v of violations) {
    console.error(`⚠️  [${v.rule}] ${v.file}:${v.line}`);
    console.error(`    代码: ${v.code}`);
    console.error(`    规则: ${v.desc}\n`);
  }
  process.exit(1);
}

console.log('✅ Go 物理不变式门禁通过，0 项违规！\n');
process.exit(0);
