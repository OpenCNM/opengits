import { test, expect } from 'vitest';
import { promotionCreateSchema, promotionUpdateSchema } from '@/lib/promotions';

test('promotionCreateSchema：合法载荷 + trim + 默认值', () => {
  const ok = promotionCreateSchema.safeParse({ title: '  秋季推荐  ' });
  expect(ok.success).toBe(true);
  if (ok.success) expect(ok.data.title).toBe('秋季推荐');
  expect(promotionCreateSchema.safeParse({ title: '' }).success).toBe(false);
  expect(promotionCreateSchema.safeParse({ title: 'x', kind: 'banner' }).success).toBe(false);
});

test('chronological refine：起止倒挂拒绝；正常起止/垃圾日期串', () => {
  expect(
    promotionCreateSchema.safeParse({ title: 'x', startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-08-01T00:00:00.000Z' }).success
  ).toBe(false);
  expect(
    promotionCreateSchema.safeParse({ title: 'x', startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z' }).success
  ).toBe(true);
  // 回归锚：曾直接 new Date(垃圾串) 进库
  expect(promotionCreateSchema.safeParse({ title: 'x', startsAt: 'not-a-date' }).success).toBe(false);
});

test('promotionUpdateSchema：title 可选（局部更新）+ subtitle:null 合法', () => {
  expect(promotionUpdateSchema.safeParse({ isPinned: false }).success).toBe(true);
  // 回归锚：曾 String(null) 落库 "null"
  expect(promotionUpdateSchema.safeParse({ subtitle: null }).success).toBe(true);
});
