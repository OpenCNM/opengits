import { z } from 'zod';
import { isPublicHttpEndpoint } from '@/lib/url-inspector';

export const modelNameSchema = z
  .string()
  .trim()
  .min(1, '模型名称不能为空')
  .max(120, '模型名称长度不能超过 120 个字符')
  .refine((m) => !/\s/.test(m), '模型名称不能包含空格');

export const CreateModelProviderSchema = z.object({
  providerKey: z.string().min(1, '供应商标识不能为空').regex(/^[a-z0-9_-]+$/i, '供应商标识仅允许英文字母、数字、下划线及连字符'),
  name: z.string().min(1, '供应商名称不能为空'),
  label: z.string().min(1, '展示标签不能为空'),
  badgeLabel: z.string().min(1, '徽标文本不能为空'),
  baseUrl: z
    .string()
    .url('Base URL 必须为合法的 URL 地址')
    .refine(isPublicHttpEndpoint, 'Base URL 不允许指向内网、回环或云元数据地址'),
  apiFormat: z.enum(['openai', 'anthropic']).default('openai'),
  defaultModel: modelNameSchema,
  models: z.array(modelNameSchema).min(1, '模型列表至少包含一个模型'),
  isEnabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  displayOrder: z.number().int().default(0),
  description: z.string().nullable().optional(),
});

export const UpdateModelProviderSchema = z.object({
  providerKey: z.string().min(1).regex(/^[a-z0-9_-]+$/i).optional(),
  name: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  badgeLabel: z.string().min(1).optional(),
  baseUrl: z
    .string()
    .url('Base URL 必须为合法的 URL 地址')
    .refine(isPublicHttpEndpoint, 'Base URL 不允许指向内网、回环或云元数据地址')
    .optional(),
  apiFormat: z.enum(['openai', 'anthropic']).optional(),
  defaultModel: modelNameSchema.optional(),
  models: z.array(modelNameSchema).min(1).optional(),
  isEnabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  displayOrder: z.number().int().optional(),
  description: z.string().nullable().optional(),
});

export const TestConnectionSchema = z.object({
  name: z.string().optional(),
  baseUrl: z
    .string()
    .min(1, 'Base URL 不能为空')
    .refine(isPublicHttpEndpoint, 'Base URL 不允许指向内网、回环或云元数据地址'),
  apiKey: z.string().min(1, 'API Key 不能为空'),
  apiFormat: z.enum(['openai', 'anthropic']).default('openai'),
  model: modelNameSchema,
});
