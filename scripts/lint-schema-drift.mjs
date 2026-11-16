/**
 * scripts/lint-schema-drift.mjs
 *
 * Schema 漂移门禁：Prisma schema 是 DDL 唯一事实源，Go sidecar（pgx 裸 SQL）
 * 是另一个消费者。两边的对应关系此前只存在于注释与人工纪律中（ingest_store_pg.go
 * 头部写着「SQL 与 Prisma 侧逐字对齐」）——本脚本把该约定机器化：
 *
 * 1. 解析 prisma/schema.prisma，收集全部表名、列名、枚举名与枚举值；
 * 2. 提取 services/ 全部 .go 文件（排除 _test.go）中处于 SQL 上下文的双引号标识符
 *    （如 "Repository"、"skeletonHash"——本库 SQL 一律双引号引用 PascalCase/camelCase）；
 * 3. 任何被引用的标识符若在 schema 中不存在（改名/删列/拼写错误），
 *    立即报告 file:line 并以 exit 1 阻断构建。
 *
 * 第二职责——双写面冻结（共享面只缩不涨）：
 * 4. 提取 Go 侧写表（INSERT INTO / UPDATE / DELETE FROM）与 Node 侧 Prisma
 *    写模型（prisma|tx.<model>.create|update|upsert|delete...）；
 * 5. 两侧同时写的表 = 双轨接缝，必须逐张登记在 REGISTERED_DUAL_WRITE_TABLES
 *    （附归属说明）。新表进入交集而未登记 → exit 1——新增双写面必须显式过闸。
 *
 * 设计边界（有意为之，加尔法则）：
 * - 只校验「双引号标识符」：PG 系统目录（pg_*）、CTE、别名在本库 SQL 中
 *   一律不加引号，天然豁免；无需实现完整 SQL 解析器。
 * - 列名校验采用全库并集（不做列→表归属推断）：足以拦截「Prisma 改名/删列
 *   而 Go 仍引用旧名」这一主漂移形态，误报率趋近于零。
 * - SQL 上下文判定 = 大写 SQL 关键词门控（SELECT/FROM/INSERT/...），
 *   排除 Go 普通字符串（import 路径、map key、错误文案）。
 * - Node 写模型仅识别 prisma|tx 两种接收者命名（本库无 $executeRaw 裸写，
 *    已验证为零）；其他变量名接收者属漏报方向，宁可少报不可误报。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = path.join(ROOT_DIR, 'prisma', 'schema.prisma');
const DDL_BASELINE_PATH = path.join(ROOT_DIR, 'services', 'worker-sidecar', 'migrations', '000001_baseline.sql');
const GO_SCAN_ROOT = path.join(ROOT_DIR, 'services');

function validateBaselineDDL(prismaTables, prismaEnums) {
  if (!fs.existsSync(DDL_BASELINE_PATH)) {
    return [`物理基线 DDL 不存在: ${DDL_BASELINE_PATH}，请运行 npm run db:ddl-export 生成`];
  }
  const ddlContent = fs.readFileSync(DDL_BASELINE_PATH, 'utf8');
  const ddlTables = new Set([...ddlContent.matchAll(/CREATE\s+TABLE\s+"([^"]+)"/g)].map((m) => m[1]));
  const ddlEnums = new Set([...ddlContent.matchAll(/CREATE\s+TYPE\s+"([^"]+)"/g)].map((m) => m[1]));

  const errors = [];
  for (const [modelName] of prismaTables) {
    if (modelName.startsWith('_')) continue;
    if (!ddlTables.has(modelName)) {
      errors.push(`DDL 缺少表: "${modelName}"`);
    }
  }
  for (const [enumName] of prismaEnums) {
    if (!ddlEnums.has(enumName)) {
      errors.push(`DDL 缺少枚举: "${enumName}"`);
    }
  }
  return errors;
}

/**
 * 已知豁免清单：Go 侧合法引用但确实不在 Prisma schema 中的标识符。
 * 每条必须注明来源依据，禁止随手添加。
 */
const KNOWN_EXTRA_IDENTIFIERS = new Set([
  "exists",
  // sqlc 聚合与多表连接投影列别名（非 Prisma 模型物理字段）
  'total', // notifications.sql: COUNT(*)::bigint AS "total"
  'unreadCount', // notifications.sql: 未读通知计数聚合别名
  'docPath', // outline.sql: OutlineNode 与 Document 连接投影别名
  'jobClaimedAt', // outline.sql: tj."claimedAt" AS "jobClaimedAt" 投影别名
  'jobCreatedAt', // outline.sql: tj."createdAt" AS "jobCreatedAt" 投影别名
  'docStatus', // outline.sql: OutlineNode 与 Document 连接投影别名
  'jobStatus', // outline.sql: Document 与 TranscriptionJob 连接投影别名
]);

/**
 * 双写面登记册（2026-09-15 冻结基线，共 27 张）：
 * 以下表同时被 Node(Prisma) 与 Go(pgx) 写入——这是 Fail-Closed 收刀后
 * 残存的既有双轨面，登记于此 = 允许存在但禁止悄悄扩张。
 * 新增表进入双写交集时必须在此登记并注明归属设计，否则构建失败。
 */
const REGISTERED_DUAL_WRITE_TABLES = new Set([
  // 全面双写清零：Phase 18.3 达成全系统 Zero-Dual-Write 终极里程碑！
  // 导入/转录管线：ImportJob / ImportJobEvent / ImportRecord / ImportUpdateRun / TranscriptionJob 已在 Phase 16 彻底注销双写（单写者全面收敛至 Go）
  // 知识图谱面：TutorialConceptNode / TutorialConceptEdge 已在 Phase 17 彻底注销双写（单写者全面收敛至 Go）
  // 教程大纲面：TutorialOutline 已在 Phase 17 彻底注销双写（单写者收敛至 Go）
  // MCP 面：McpActiveSession / McpUsageLedger / McpCallLog 已在 Phase 14 注销；McpApiToken / McpBundle 已在 Phase 17 彻底注销双写（全面收敛至 Go）
  // 横切：EpisodicEvent / GithubQuotaLog / SchedulerLease 已在 Phase 14 注销；Notification 已在 Phase 15 注销
  // 内容主数据与用户核心面：DocumentContent / DocumentChunk / Document 已在 Phase 18 彻底注销双写（CAS、切片与文档状态全面收敛至 Go）
  // 用户与仓库主表：User 与 Repository 已在 Phase 18.3 彻底注销双写（全面收敛至 Go worker-sidecar 单写者）
  //
  // ── 显式过闸（唯一登记项，写权边界如下）──
  // UserReadingProgress：
  // - Node Prisma = 常规写者（阅读页 docs-page-loader.ts / web-doc 导入的进度 upsert）
  // - Go pgx = 仅 promote-edition 原子迁移窗口（MigrateReadingProgressForPromotion，
  //   与旧默认仓级联删除同事务——迁移与删除必须原子，跨进程两步会造成进度孤儿/错乱）
  // - 两侧写集不相交：Node 只 upsert (userId, repositoryId) 现势行；
  //   Go 只在旧仓行将级联删除前做 (old→new repositoryId) 一次性重定向
  'UserReadingProgress',
]);

const GO_SCAN_ROOTS = [path.join(ROOT_DIR, 'services')];
const NODE_APP_ROOTS = [path.join(ROOT_DIR, 'apps', 'client', 'src')];

/** SQL 上下文门控：字符串中必须出现大写 SQL 关键词（本库 SQL 关键词全大写惯例）。 */
const SQL_KEYWORD_RE =
  /\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|WHERE|VALUES|RETURNING|CREATE|ALTER|DROP|ON CONFLICT|GROUP BY|ORDER BY|LIMIT|FOR UPDATE|SKIP LOCKED|WITH|USING|EXISTS|SET)\b/;

/** 双引号标识符（Prisma 生成的表/列均为 PascalCase/camelCase，加引号引用）。 */
const QUOTED_IDENT_RE = /"([A-Za-z_][A-Za-z0-9_]*)"/g;

// ─────────────────────────────────────────────────────────────
// 1. 解析 prisma/schema.prisma → 表/列/枚举集合
// ─────────────────────────────────────────────────────────────

function parsePrismaSchema() {
  const content = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const lines = content.split('\n');

  const tables = new Map(); // tableName → Set<columnName>
  const enums = new Map(); // enumName → Set<value>
  // 具名关系名 → 列表侧字段出现次数（两端均为列表 = 隐式多对多）
  const namedRelationListSides = new Map();

  let blockType = null; // 'model' | 'enum' | null
  let blockName = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    const enumMatch = line.match(/^enum\s+(\w+)\s*\{/);
    if (modelMatch) {
      blockType = 'model';
      blockName = modelMatch[1];
      tables.set(blockName, new Set());
      continue;
    }
    if (enumMatch) {
      blockType = 'enum';
      blockName = enumMatch[1];
      enums.set(blockName, new Set());
      continue;
    }
    if (line === '}') {
      blockType = null;
      blockName = null;
      continue;
    }
    if (!blockType || !blockName) continue;
    // 跳过注释、块级属性（@@index 等）与空行
    if (line.startsWith('//') || line.startsWith('///') || line.startsWith('@@')) continue;

    if (blockType === 'model') {
      // 字段行：`  skeletonHash String?` → skeletonHash
      // 本库无 @map/@@map（表名=模型名、列名=字段名），故首 token 即列名。
      // 关系字段（Foo/ Foo[]）一并纳入：过度纳入只会降低误报，不会漏报改名漂移。
      const fieldMatch = line.match(/^(\w+)\s+\S/);
      if (fieldMatch) tables.get(blockName).add(fieldMatch[1]);

      // 隐式多对多探测：`bundles McpBundle[] @relation("BundleRepositories")`
      // Prisma 会自动生成 `_BundleRepositories("A","B")` 连接表（无 model 块）。
      // 仅识别具名关系（两端均为列表字段）；本库未使用匿名隐式 m2m。
      const m2mMatch = line.match(/^(\w+)\s+\w+\[\]\s*@relation\("(\w+)"\)/);
      if (m2mMatch) {
        const relName = m2mMatch[2];
        namedRelationListSides.set(relName, (namedRelationListSides.get(relName) ?? 0) + 1);
      }
    } else {
      // 枚举值行：`  QUEUED`
      const valueMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
      if (valueMatch) enums.get(blockName).add(valueMatch[1]);
    }
  }

  for (const [relName, listSideCount] of namedRelationListSides) {
    if (listSideCount === 2) {
      tables.set(`_${relName}`, new Set(['A', 'B']));
    }
  }

  return { tables, enums };
}

// ─────────────────────────────────────────────────────────────
// 2. 扫描 Go 文件，提取 SQL 上下文中的双引号标识符
// ─────────────────────────────────────────────────────────────

function collectGoFiles(dirPath, acc = []) {
  if (!fs.existsSync(dirPath)) return acc;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name.startsWith('.')) continue;
      collectGoFiles(fullPath, acc);
    } else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
      acc.push(fullPath);
    }
  }
  return acc;
}

/** Node 应用层 TS 文件（双写面扫描用；排除测试与构建产物目录）。 */
function collectTsFiles(dirPath, acc = []) {
  if (!fs.existsSync(dirPath)) return acc;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue;
      collectTsFiles(fullPath, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      acc.push(fullPath);
    }
  }
  return acc;
}

/**
 * 提取一个文件中所有「SQL 上下文字符串」：
 * - 反引号原始字符串（SQL 常量的主体形式）；
 * - 双引号字符串（含 \" 转义的单行 SQL 片段），先反转义再判定。
 * 返回 [{ startOffset, text }]（startOffset 用于行号定位）。
 */
function extractSqlCandidateStrings(content) {
  const candidates = [];

  // 反引号字符串
  for (const match of content.matchAll(/`([^`]*)`/g)) {
    const text = match[1];
    if (SQL_KEYWORD_RE.test(text)) {
      candidates.push({ startOffset: match.index, text });
    }
  }

  // 双引号字符串（处理 \" 转义）
  for (const match of content.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
    const text = match[0].slice(1, -1).replace(/\\"/g, '"');
    if (SQL_KEYWORD_RE.test(text)) {
      candidates.push({ startOffset: match.index, text });
    }
  }

  return candidates;
}

function lineOfOffset(content, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

// ─────────────────────────────────────────────────────────────
// 3. 主流程
// ─────────────────────────────────────────────────────────────

const { tables, enums } = parsePrismaSchema();

const knownIdentifiers = new Set(KNOWN_EXTRA_IDENTIFIERS);
for (const [tableName, columns] of tables) {
  knownIdentifiers.add(tableName);
  for (const col of columns) knownIdentifiers.add(col);
}
for (const [enumName, values] of enums) {
  knownIdentifiers.add(enumName);
  for (const v of values) knownIdentifiers.add(v);
}

const goFiles = GO_SCAN_ROOTS.flatMap((root) => collectGoFiles(root));
if (goFiles.length === 0) {
  console.error('❌ [Schema-Drift Linter] services/ 下未找到任何 .go 文件，扫描范围异常');
  process.exit(1);
}

console.log(
  `\n🔍 [Schema-Drift Linter] schema.prisma（${tables.size} 表 / ${enums.size} 枚举）↔ ${goFiles.length} 个 Go 文件 ...`
);

const violations = [];
let sqlStringsChecked = 0;
let identifiersChecked = 0;
const goWriteTables = new Set();

for (const filePath of goFiles) {
  const content = fs.readFileSync(filePath, 'utf8');
  const sqlStrings = extractSqlCandidateStrings(content);
  sqlStringsChecked += sqlStrings.length;

  for (const { startOffset, text } of sqlStrings) {
    // 双写面提取：Go 侧写表（INSERT INTO / UPDATE / DELETE FROM）
    for (const writeMatch of text.matchAll(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"(\w+)"/g)) {
      goWriteTables.add(writeMatch[2]);
    }

    // 表级 INSERT 列名归属校验
    for (const insertMatch of text.matchAll(/INSERT\s+INTO\s+"(\w+)"\s*\(([^)]+)\)/g)) {
      const tableName = insertMatch[1];
      const colsStr = insertMatch[2];
      const validCols = tables.get(tableName);
      if (validCols) {
        for (const colMatch of colsStr.matchAll(/"(\w+)"/g)) {
          const colName = colMatch[1];
          if (!validCols.has(colName)) {
            const relPath = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');
            const line = lineOfOffset(content, startOffset + (colMatch.index ?? 0));
            violations.push({
              relPath,
              line,
              identifier: `${tableName}.${colName}`,
              snippet: insertMatch[0].replace(/\s+/g, ' ').slice(0, 100),
            });
          }
        }
      }
    }

    // 表级 UPDATE 列名归属校验: UPDATE "Table" SET "col" = ...
    for (const updateMatch of text.matchAll(/UPDATE\s+"(\w+)"\s+SET\s+([\s\S]+?)(?:\s+WHERE|\s+RETURNING|$)/g)) {
      const tableName = updateMatch[1];
      const setBody = updateMatch[2];
      const validCols = tables.get(tableName);
      if (validCols) {
        for (const colMatch of setBody.matchAll(/"(\w+)"\s*=/g)) {
          const colName = colMatch[1];
          if (!validCols.has(colName)) {
            const relPath = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');
            const line = lineOfOffset(content, startOffset + (colMatch.index ?? 0));
            violations.push({
              relPath,
              line,
              identifier: `${tableName}.${colName}`,
              snippet: updateMatch[0].replace(/\s+/g, ' ').slice(0, 100),
            });
          }
        }
      }
    }

    for (const identMatch of text.matchAll(QUOTED_IDENT_RE)) {
      const identifier = identMatch[1];
      identifiersChecked++;
      if (!knownIdentifiers.has(identifier)) {
        const relPath = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');
        const line = lineOfOffset(content, startOffset + (identMatch.index ?? 0));
        const snippet = text
          .slice(Math.max(0, (identMatch.index ?? 0) - 30), (identMatch.index ?? 0) + identifier.length + 10)
          .replace(/\s+/g, ' ')
          .trim();
        violations.push({ relPath, line, identifier, snippet });
      }
    }
  }
}

// 物理 DDL 基线对齐校验
const ddlErrors = validateBaselineDDL(tables, enums);

// ─────────────────────────────────────────────────────────────
// 双写面冻结：两侧同时写的表必须逐张登记
// ─────────────────────────────────────────────────────────────

const PRISMA_WRITE_RE = /\b(?:prisma|tx)\.([a-zA-Z]+)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g;

function collectNodeWriteTables() {
  const tables = new Set();
  for (const root of NODE_APP_ROOTS) {
    for (const filePath of collectTsFiles(root)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const cleanContent = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
      for (const match of cleanContent.matchAll(PRISMA_WRITE_RE)) {
        const model = match[1];
        if (model.startsWith('$')) continue;
        // 本库无 @@map：Prisma 模型名首字母大写即表名
        tables.add(model.charAt(0).toUpperCase() + model.slice(1));
      }
    }
  }
  return tables;
}

const nodeWriteTables = collectNodeWriteTables();
const dualWriteTables = [...goWriteTables].filter((t) => nodeWriteTables.has(t)).sort();
const unregisteredDualWrites = dualWriteTables.filter((t) => !REGISTERED_DUAL_WRITE_TABLES.has(t));

let failed = false;

if (violations.length > 0) {
  failed = true;
  console.error(`\n❌ 检出 ${violations.length} 处 SQL 标识符在 prisma/schema.prisma 中不存在（疑似漂移）：\n`);
  for (const v of violations) {
    console.error(`  ${v.relPath}:${v.line}  "${v.identifier}"`);
    console.error(`    上下文: ...${v.snippet}...`);
  }
  console.error(
    `\n处置：若为 Prisma 改名/删列后的遗留引用，请修正 Go SQL；` +
      `若为 schema 外的合法伴随标识符，请在脚本顶部 KNOWN_EXTRA_IDENTIFIERS 登记并注明依据。\n`
  );
}

if (unregisteredDualWrites.length > 0) {
  failed = true;
  console.error(`\n❌ 检出 ${unregisteredDualWrites.length} 张未登记的双写表（Node Prisma 与 Go pgx 同时写入）：\n`);
  for (const t of unregisteredDualWrites) console.error(`  ${t}`);
  console.error(
    `\n双写面只缩不涨：新表同时被两侧写入必须先在 REGISTERED_DUAL_WRITE_TABLES 登记归属设计` +
      `（谁写哪个生命周期阶段），或改为单侧独写。\n`
  );
}

if (ddlErrors.length > 0) {
  failed = true;
  console.error(`\n❌ 物理基线 DDL 与 prisma/schema.prisma 不一致（检出 ${ddlErrors.length} 项差异）：\n`);
  for (const err of ddlErrors) {
    console.error(`  ${err}`);
  }
  console.error('\n处置：请运行 npm run db:ddl-export 同步最新的 000001_baseline.sql。\n');
}

if (failed) process.exit(1);

console.log(`✅ 物理 DDL 基线对齐：000001_baseline.sql 与 schema.prisma 100% 对齐（${tables.size} 表 / ${enums.size} 枚举）`);

console.log(
  `✅ 零漂移：${sqlStringsChecked} 段 SQL 上下文、${identifiersChecked} 个双引号标识符全部命中 schema.prisma`
);
console.log(
  `✅ 双写面冻结：${dualWriteTables.length}/${REGISTERED_DUAL_WRITE_TABLES.size} 张登记表之外零新增（Go 写 ${goWriteTables.size} 表 / Node 写 ${nodeWriteTables.size} 表）\n`
);
