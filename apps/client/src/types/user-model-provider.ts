import { z } from 'zod';
import { isPublicHttpEndpoint } from '@/lib/url-inspector';
import * as m from '@/paraglide/messages';

export interface UserModelProviderDTO {
  id: string;
  userId?: string;
  providerKey: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  maskedApiKey?: string;
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
  baseUrl: z.string().min(1, m.provider_err_base_url_required()).refine(isPublicHttpEndpoint, m.provider_err_base_url_invalid()),
  apiKey: z.string().optional(),
  apiFormat: z.enum(['openai', 'anthropic']).default('openai'),
  models: z.array(z.string()).min(1, m.provider_err_min_models()),
  selectedModel: z.string().min(1, m.provider_err_active_model_required()),
  isActive: z.boolean().default(false),
});
