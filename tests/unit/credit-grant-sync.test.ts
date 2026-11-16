import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PENDING_CREDIT_STATUS,
  isTerminalPendingCreditStatus,
} from '@/lib/schemas/credit-grant';

const PRISMA_SCHEMA = join(__dirname, '../../prisma/schema.prisma');
const GO_CREDITS_SQL = join(
  __dirname,
  '../../services/worker-sidecar/internal/platform/db/credits.sql.go'
);

/** 从 Prisma schema 的 PendingCreditGrant 模型块提取 status 注释词汇与默认值 */
function parsePrismaVocab(): { commentValues: string[]; defaultValue: string } {
  const src = readFileSync(PRISMA_SCHEMA, 'utf8');
  const modelMatch = src.match(/model PendingCreditGrant \{[\s\S]*?\n\}/);
  if (!modelMatch) throw new Error('未找到 PendingCreditGrant 模型');
  const statusLine = modelMatch[0]
    .split('\n')
    .find((l) => l.trim().startsWith('status '));
  if (!statusLine) throw new Error('未找到 status 字段');
  const commentValues = (statusLine.match(/\/\/\s*(.+)$/)?.[1] ?? '')
    .split('|')
    .map((v) => v.trim())
    .filter(Boolean);
  const defaultValue = statusLine.match(/@default\("([A-Z]+)"\)/)?.[1] ?? '';
  return { commentValues, defaultValue };
}

/** 从 Go sqlc 生成的 credits.sql.go 提取 PendingCreditGrant 表查询块中的状态字面量 */
function parseGoStatusLiterals(): Set<string> {
  const src = readFileSync(GO_CREDITS_SQL, 'utf8');
  const literals = new Set<string>();
  // 按 sqlc 查询边界切块，只取 SQL 文本涉及 PendingCreditGrant 表的查询
  // （同文件还有 ImportJob 等其他表的 status 列，如 'COMPLETED'，不属于积分词汇）
  const blocks = src.split(/-- name: \w+ :/).slice(1);
  for (const block of blocks) {
    if (!block.includes('PendingCreditGrant')) continue;
    // 只取 SET/WHERE 的 status 赋值与比较；INSERT 默认值由 Prisma @default 断言覆盖
    for (const [, lit] of block.matchAll(/"status"\s*=\s*'([A-Z]+)'/g)) {
      literals.add(lit);
    }
  }
  return literals;
}

describe('积分授予跨语言同步锁（Prisma ↔ Go SQL ↔ TS 三方对拍）', () => {
  const tsValues = Object.values(PENDING_CREDIT_STATUS);

  it('Prisma 注释词汇与 TS 词汇逐字一致（schema 改词汇必须同步 TS）', () => {
    const { commentValues, defaultValue } = parsePrismaVocab();
    expect([...commentValues].sort()).toEqual([...tsValues].sort());
    expect(tsValues).toContain(defaultValue);
  });

  it('Go credits.sql.go 的全部 status 字面量 ⊆ TS 词汇（Go 新增状态必须显式同步）', () => {
    const goLiterals = parseGoStatusLiterals();
    expect(goLiterals.size).toBeGreaterThan(0);
    for (const lit of goLiterals) {
      expect(
        tsValues,
        `Go SQL 出现 TS 未知的积分状态 '${lit}' —— 积分是资产域，禁止静默漂移，请同步 PENDING_CREDIT_STATUS`
      ).toContain(lit);
    }
  });

  it('TS 每个状态都在 Go SQL 中被实际消费（TS 私增状态同样禁止）', () => {
    const goLiterals = parseGoStatusLiterals();
    for (const v of tsValues) {
      expect(goLiterals.has(v), `TS 状态 '${v}' 在 Go SQL 中无任何消费点`).toBe(true);
    }
  });

  it('终态语义：UNLOCKED 唯一吸收终态；CANCELLED 可被重发布复活（非终态）', () => {
    expect(isTerminalPendingCreditStatus('UNLOCKED')).toBe(true);
    expect(isTerminalPendingCreditStatus('CANCELLED')).toBe(false);
    expect(isTerminalPendingCreditStatus('PENDING')).toBe(false);
  });
});
