import { z } from 'zod';

export const TAG_KINDS = ['CATEGORY', 'TAG'] as const;
export const TagKindSchema = z.enum(TAG_KINDS);
export type TagKind = (typeof TAG_KINDS)[number];

export const TAG_SOURCES = ['seed', 'ai', 'admin', 'legacy'] as const;
export type TagSource = (typeof TAG_SOURCES)[number];

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

export const tagRegistryCreateSchema = z.object({
  value: registryValueSchema,
  kind: TagKindSchema,
  aliases: z.array(registryValueSchema).max(20).default([]),
});

export const tagRegistryUpdateSchema = z.object({
  value: registryValueSchema.optional(),
  aliases: z.array(registryValueSchema).max(20).optional(),
  isActive: z.boolean().optional(),
});

export const repoCategoryInputSchema = z.string().trim().min(1).max(40);
export const repoTagsInputSchema = z.array(z.string().trim().min(1).max(40)).max(12).default([]);
