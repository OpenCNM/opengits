import { z } from 'zod';

export const PROMOTION_KINDS = ['promotion', 'announcement'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

const isoDateTime = z.string().refine(
  (v) => !Number.isNaN(Date.parse(v)),
  { message: 'Must be a valid ISO datetime string' }
);

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

export const promotionUpdateSchema = chronologicalRefine(
  z.object({ ...promotionShape, title: promotionShape.title.optional() })
);

export type PromotionCreateInput = z.infer<typeof promotionCreateSchema>;
export type PromotionUpdateInput = z.infer<typeof promotionUpdateSchema>;
