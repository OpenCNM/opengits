import { z } from 'zod';
import { isPublicHttpEndpoint } from '@/lib/url-inspector';
import * as m from '@/paraglide/messages';

/**
 * apiKey 语义（Phase A 密钥安全改造后）：
 * - 服务端 GET/POST/PATCH 响应永不回传明文，只回 maskedApiKey + hasApiKey；
 * - apiKey 字段仅存在于三类场景：用户表单输入、本地 localStorage 副本（用户自己的
 *   key 存自己的机器）、lease 端点解密租用。
 */
export interface UserModelProviderDTO {
  id: string;
  userId?: string;
  providerKey: string;
  name: string;
  baseUrl: string;
  /** 仅本地/表单态存在；云端响应恒为 undefined */
  apiKey?: string;
  /** 云端响应的掩码形态（唯一可见形态） */
  maskedApiKey?: string;
  /** 云端响应：是否已配置 Key（本地态恒 true） */
  hasApiKey?: boolean;
  apiFormat: 'openai' | 'anthropic';
  models: string[];
  selectedModel: string;
  isActive: boolean;
  healthStatus: 'healthy' | 'unhealthy' | 'unknown';
  latencyMs?: number | null;
  lastError?: string | null;
  lastTestedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export const UpsertUserModelProviderSchema = z.object({
  id: z.string().optional(),
  providerKey: z.string().min(1, m.provider_err_id_required()),
  name: z.string().min(1, m.provider_err_name_required()),
  // SSRF 防护：保存的模型端点会被服务端发起请求（chat/转录/测速），禁止私网/回环/云元数据
  baseUrl: z.string().min(1, m.provider_err_base_url_required()).refine(isPublicHttpEndpoint, m.provider_err_base_url_invalid()),
  /** 空串/缺省 = 编辑时保留既有 Key（服务端判create 必填）；明文仅在提交瞬间存在 */
  apiKey: z.string().optional(),
  apiFormat: z.enum(['openai', 'anthropic']).default('openai'),
  models: z.array(z.string()).min(1, m.provider_err_min_models()),
  selectedModel: z.string().min(1, m.provider_err_active_model_required()),
  isActive: z.boolean().default(false),
});
