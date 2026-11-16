/**
 * 转录共享类型（2026-10 收口；2026-11 清算）：执行编排类型与 DocContext
 * 已随 Node 执行器退役删除，仅存 toProfileRecord（Prisma JSON 列 → 画像记录，
 * update-market jobs/versions 消费）。
 */

/** Prisma JSON 列 → 画像记录（落库前由写入侧保证为对象） */
export function toProfileRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
