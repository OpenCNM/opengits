import { z } from 'zod';

/**
 * TagRegistry 三件套之 Zod 层（与 prisma/schema.prisma 的 TagKind/TagRegistry
 * 及 tag-registry.ts 的 TS 类型同步维护；改任何一层必须同步其余两层）。
 */

export const TAG_KINDS = ['CATEGORY', 'TAG'] as const;
export const TagKindSchema = z.enum(TAG_KINDS);
export type TagKind = (typeof TAG_KINDS)[number];

/** 词表来源（schema 注释同步：seed | ai | admin | legacy） */
export const TAG_SOURCES = ['seed', 'ai', 'admin', 'legacy'] as const;
export type TagSource = (typeof TAG_SOURCES)[number];

/**
 * 规范值/别名共用形态：trim 后非空、≤40 字符、无控制类空白；
 * 允许单个内部空格（存量常量为空格形式，如 'Web Docs'、'Computer Science'）。
 */
const registryValueSchema = z
  .string()
  .trim()
  .min(1, '标签值不能为空')
  .max(40, '标签值不能超过 40 个字符')
  .refine((v) => !/[\t\n\r]/.test(v) && !/ {2,}/.test(v), '标签值只能包含单个空格，不能含制表符/换行');

export const TagRegistryEntrySchema = z.object({
  id: z.string(),
  value: registryValueSchema,
  kind: TagKindSchema,
  aliases: z.array(registryValueSchema).max(20).default([]),
  source: z.string(),
  isActive: z.boolean(),
  createdAt: z.date().nullable().optional(),
  updatedAt: z.date().nullable().optional(),
});
export type TagRegistryEntry = z.infer<typeof TagRegistryEntrySchema>;

/** POST /api/admin/tag-registry 创建入参 */
export const tagRegistryCreateSchema = z.object({
  value: registryValueSchema,
  kind: TagKindSchema,
  aliases: z.array(registryValueSchema).max(20).default([]),
});

/** PUT /api/admin/tag-registry/[id] 编辑入参（全部可选，部分更新） */
export const tagRegistryUpdateSchema = z.object({
  value: registryValueSchema.optional(),
  aliases: z.array(registryValueSchema).max(20).optional(),
  isActive: z.boolean().optional(),
});

/** 导入链路里 Repository.category/tags 写入前的轻量校验 */
export const repoCategoryInputSchema = z.string().trim().min(1).max(40);
export const repoTagsInputSchema = z.array(z.string().trim().min(1).max(40)).max(12).default([]);
