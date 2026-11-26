#!/usr/bin/env node
/**
 * scripts/audit-matrix.mjs
 * 审计矩阵（ATOMIC_SYSTEM_AUDIT_MATRIX）统一工具：支持生成 (--write) 与防漂移门禁 (--check / default)。
 *
 * 用法：
 *   node scripts/audit-matrix.mjs --write    # 从 apps/client/doc/audit-matrix.json 生成 ATOMIC_SYSTEM_AUDIT_MATRIX.md
 *   node scripts/audit-matrix.mjs --check    # 物理事实层防漂移校验（CI/verify 门禁）
 *   node scripts/audit-matrix.mjs --report   # 预览全量漂移但不阻塞
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const JSON_PATH = path.join(ROOT_DIR, 'apps/client/doc/audit-matrix.json');
const DOC_PATH = path.join(ROOT_DIR, 'apps/client/doc/ATOMIC_SYSTEM_AUDIT_MATRIX.md');
const TESTS_DIR = path.join(ROOT_DIR, 'tests');
const SIDECAR_DIR = path.join(ROOT_DIR, 'services/worker-sidecar');

const isWrite = process.argv.includes('--write');
const REPORT_ONLY = process.argv.includes('--report');

// ── 1. 生成模式 (--write) ──────────────────────────────────────────
function runGenerate() {
  const VECTOR_ID = /\*\[(\d+\.\d+\.\d+\.\d+)/g;
  const CHECKPOINT_ID = /\*\*\[(\d+\.\d+\.\d+) · /g;

  const doc = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));

  // 预统计（总览表 + 断言用）
  const stats = doc.modules.map((mod) => {
    let checkpoints = 0;
    let vectors = 0;
    const files = new Set();
    for (const unit of mod.units) {
      const body = unit.lines.join('\n');
      checkpoints += [...body.matchAll(CHECKPOINT_ID)].length;
      vectors += [...body.matchAll(VECTOR_ID)].length;
      unit.files.forEach((f) => files.add(f));
    }
    return { id: mod.id, units: mod.units.length, checkpoints, vectors, fileCount: files.size };
  });
  const totalVectors = stats.reduce((s, m) => s + m.vectors, 0);
  const statById = new Map(stats.map((s) => [s.id, s]));

  const out = [];
  let tableRowCount = 0;
  for (const line of doc.header) {
    // 总览表模块行动态重算：| **M01** | 领域 | `5` | `16` | `20` | `key` |
    if (/^\| \*\*M\d+\*\* /.test(line)) {
      const mod = doc.modules[tableRowCount];
      const s = statById.get(mod.id);
      out.push(`| **${mod.id}** | ${mod.title} | \`${s.units}\` | \`${s.checkpoints}\` | \`${s.fileCount}\` | \`${mod.key}\` |`);
      tableRowCount++;
    } else {
      out.push(line);
    }
  }
  if (tableRowCount > 0 && tableRowCount !== doc.modules.length) {
    console.error(`🚨 总览表行数（${tableRowCount}）与模块数（${doc.modules.length}）不一致，请检查 JSON header`);
    process.exit(1);
  }

  for (const mod of doc.modules) {
    out.push(`### ${mod.id}: ${mod.title} (\`${mod.key}\`)`, '');
    out.push(...mod.intro);
    for (const unit of mod.units) out.push(...unit.lines);
  }
  out.push(...doc.tail);

  const text = out.join('\n');
  const emittedVectors = [...text.matchAll(VECTOR_ID)].length;
  if (emittedVectors !== totalVectors) {
    console.error(`🚨 向量数不一致：JSON ${totalVectors} vs 产物 ${emittedVectors}——意图层在生成中丢失，拒绝写盘`);
    process.exit(1);
  }
  const emittedUnits = doc.modules.reduce((s, m) => s + m.units.length, 0);

  fs.writeFileSync(DOC_PATH, text, 'utf-8');
  console.log(`✅ 生成完成 ➔ ${path.relative(ROOT_DIR, DOC_PATH)}`);
  console.log(`📊 模块 ${doc.modules.length}，单元 ${emittedUnits}，检查点 ${stats.reduce((s, m) => s + m.checkpoints, 0)}，向量 ${emittedVectors}（断言一致），漂移行 ${(text.match(/- \*\*FactDrift\*\*/g) || []).length}`);
}

// ── 2. 校验门禁模式 (--check / default) ───────────────────────────
function runLint() {
  const UNIT_HEADER = /^#### \[(\d+\.\d+)\] /;
  const BACKTICK_TOKEN = /`([^`]+)`/g;
  const VECTOR_ID = /(?:🧪\s*)?\*+\[(\d+\.\d+\.\d+\.\d+)/g;
  const CHECKED_AT = /CheckedAt:\d{4}-\d{2}-\d{2}/;
  const RE_AUDITED = /ReAudited:\d{4}-\d{2}-\d{2}/;
  const HTTP_VERB = /^(GET|POST|PUT|PATCH|DELETE) (\/\S+)/;

  let errors = 0;
  let warnings = 0;

  function fail(msg) {
    console.error(`❌ ${msg}`);
    errors++;
  }
  function warn(msg) {
    console.warn(`⚠️  ${msg}`);
    warnings++;
  }

  const lines = fs.readFileSync(DOC_PATH, 'utf-8').split(/\r?\n/);
  const units = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(UNIT_HEADER);
    if (m) {
      if (current) units.push(current);
      current = { id: m[1], startLine: i + 1, body: [] };
    } else if (current) {
      if (/^### /.test(lines[i])) {
        units.push(current);
        current = null;
      } else {
        current.body.push(lines[i]);
      }
    }
  }
  if (current) units.push(current);

  for (const unit of units) {
    unit.filesLine = unit.body.find((l) => l.startsWith('- **Files**:')) || '';
    unit.files = [...unit.filesLine.matchAll(BACKTICK_TOKEN)].map((m) => m[1]);
    const contractLine = unit.body.find((l) => l.startsWith('- **Contract**:')) || '';
    const contractMatch = contractLine.match(/`([^`]+)`/);
    unit.contract = contractMatch ? contractMatch[1] : '';
    unit.inspection = unit.body.find((l) => l.startsWith('- **Inspection**:')) || '';
    unit.vectors = [...unit.body.join('\n').matchAll(VECTOR_ID)].map((m) => m[1]);
  }

  console.log(`\n🔍 [Audit-Matrix Lint] 解析到 ${units.length} 个原子单元（${DOC_PATH.split('client').pop()}）\n`);

  const fileContentCache = new Map();
  function readFileContent(relPath) {
    if (fileContentCache.has(relPath)) return fileContentCache.get(relPath);
    let content = null;
    try {
      content = fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf-8');
    } catch {
      content = null;
    }
    fileContentCache.set(relPath, content);
    return content;
  }

  function collectTests(dir, pattern, acc = '') {
    if (!fs.existsSync(dir)) return acc;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules' || name === 'vendor') continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) acc = collectTests(full, pattern, acc);
      else if (pattern.test(name)) acc += fs.readFileSync(full, 'utf-8');
    }
    return acc;
  }

  const testsContent =
    collectTests(TESTS_DIR, /\.(test|spec)\.(ts|tsx|mjs)$/) +
    collectTests(SIDECAR_DIR, /_test\.go$/);

  let auditedUnits = 0;
  const uncoveredVectors = [];

  for (const unit of units) {
    const tag = `[${unit.id}]`;

    // E1：Files 路径必须真实存在（全量单元）
    for (const f of unit.files) {
      if (!fs.existsSync(path.join(ROOT_DIR, f))) {
        fail(`${tag} E1 Files 路径不存在: ${f}（文档第 ${unit.startLine} 行附近）`);
      }
    }

    // E3：✅ 已验收必须携带 CheckedAt（可证据化）
    if (unit.inspection.includes('✅') && !CHECKED_AT.test(unit.inspection)) {
      fail(`${tag} E3 Inspection 声称 ✅ 已验收但缺少 CheckedAt:YYYY-MM-DD 标记`);
    }

    const isAudited = RE_AUDITED.test(unit.inspection);
    if (isAudited) auditedUnits++;

    // E2：Contract 符号必须真实存在于该单元 Files 中（仅已深审单元硬化）
    if (unit.contract) {
      const routeMatch = unit.contract.match(HTTP_VERB);
      let resolved = false;
      if (routeMatch) {
        const rawSeg = routeMatch[2].split('?')[0].replace(/^\/api\//, '');
        const segNoExt = rawSeg.replace(/\.(xml|txt|json|rss)$/i, '');
        resolved = unit.files.some((f) => f.includes(rawSeg) || f.includes(segNoExt));
      } else {
        const symbol = (unit.contract.match(/^[A-Za-z_$][A-Za-z0-9_$]*/) || [])[0];
        if (symbol) {
          resolved = unit.files.some((f) => (readFileContent(f) || '').includes(symbol));
        }
      }
      if (!resolved) {
        const msg = `${tag} E2 Contract「${unit.contract}」未能在其 Files 文件中找到对应实现（文档第 ${unit.startLine} 行附近）`;
        if (REPORT_ONLY || !isAudited) warn(`${msg}（未深审单元，--report 预览）`);
        else fail(msg);
      }
    }

    // R1：向量测试背书
    for (const v of unit.vectors) {
      if (!testsContent.includes(v)) uncoveredVectors.push(v);
    }
  }

  console.log(`📊 单元总数 ${units.length}，已深审（ReAudited 硬化门禁）${auditedUnits} 个`);
  if (uncoveredVectors.length > 0) {
    console.log(`📋 R1 ${uncoveredVectors.length} 条 🧪 向量暂无测试引用（示例: ${uncoveredVectors.slice(0, 8).join(', ')}${uncoveredVectors.length > 8 ? ' ...' : ''}）`);
  }

  if (errors > 0) {
    console.error(`\n🚨 [Audit-Matrix Lint] ${errors} 个错误，${warnings} 个警告——文档事实层与代码不一致，禁止通过验收。\n`);
    process.exit(1);
  }
  console.log(`\n✅ [Audit-Matrix Lint] 事实层校验通过（${warnings} 个未深审单元漂移警告）。\n`);
}

if (isWrite) {
  runGenerate();
} else {
  runLint();
}
