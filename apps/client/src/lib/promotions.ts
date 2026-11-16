import { z } from 'zod';

/**
 * ─────────────────────────────────────────────────────────────
 * PlatformPromotion 校验层（Schema Triad 的 Zod 一层）
 *
 * Prisma model（prisma/schema.prisma）↔ 本 Zod schema ↔ 路由消费的
 * z.infer 类型，三层字段同步；新增字段必须三处同改。
 * kind/startsAt/endsAt/dismissible 为 Phase 4 公告扩展字段。
 * ─────────────────────────────────────────────────────────────
 */

// 推荐位类型注册表（与 Prisma kind 列注释保持一致，禁止内联）
export const PROMOTION_KINDS = ['promotion', 'announcement'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

/** ISO 时间串校验（拒绝 NaN 日期，防止 Invalid Date 进库） */
const isoDateTime = z.string().refine(
  (v) => !Number.isNaN(Date.parse(v)),
  { message: 'Must be a valid ISO datetime string' }
);

/** 起止时间一致性：两者都提供时 startsAt 不得晚于 endsAt */
function chronologicalRefine<T extends { startsAt?: string | null; endsAt?: string | null }>(schema: z.ZodType<T>) {
  return schema.refine(
    (v) => !(v.startsAt && v.endsAt) || Date.parse(v.startsAt) <= Date.parse(v.endsAt),
    { message: 'startsAt must not be after endsAt', path: ['startsAt'] }
  );
}

const promotionShape = {
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().trim().max(300).nullable().optional(),
  targetUrl: z.string().trim().max(500).nullable().optional(),
  badge: z.string().trim().max(100).optional(),
  isPinned: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  kind: z.enum(PROMOTION_KINDS).optional(),
  startsAt: isoDateTime.nullable().optional(),
  endsAt: isoDateTime.nullable().optional(),
  dismissible: z.boolean().optional(),
};

export const promotionCreateSchema = chronologicalRefine(z.object(promotionShape));

/** 局部更新：title 也放开为可选（未提供 = 保留原值） */
export const promotionUpdateSchema = chronologicalRefine(
  z.object({ ...promotionShape, title: promotionShape.title.optional() })
);

export type PromotionCreateInput = z.infer<typeof promotionCreateSchema>;
export type PromotionUpdateInput = z.infer<typeof promotionUpdateSchema>;
