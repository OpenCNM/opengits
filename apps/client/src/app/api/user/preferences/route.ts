import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

export const dynamic = 'force-dynamic';

const PreferencesBodySchema = z.object({
  preferredLang1: z.string().optional(),
  preferredLang2: z.string().optional(),
  preferredLang3: z.string().optional(),
  industry: z.string().optional(),
  primaryProgLang: z.string().optional(),
  secondaryProgLang: z.string().optional(),
  fontSize: z.string().optional(),
  disabledMcpRepoIds: z.array(z.string()).optional(),
});

interface UserPreferencesSidecarResponse {
  ok: boolean;
  preferences?: {
    hasPreferencesSet: boolean;
    preferredLang1?: string | null;
    preferredLang2?: string | null;
    preferredLang3?: string | null;
    industry?: string | null;
    primaryProgLang?: string | null;
    secondaryProgLang?: string | null;
    fontSize: string;
    disabledMcpRepoIds: string[];
    savedRepositories: Array<{
      id: string;
      owner: string;
      repo: string;
      mcpStatus: string;
      totalDocs: number;
      processedDocs: number;
      isProcessed: boolean;
      progress: number;
    }>;
  };
  error?: string;
}

interface UserPreferencesSetSidecarResponse {
  ok: boolean;
  user?: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
    role: string;
    tier: string;
    preferredLang1?: string | null;
    preferredLang2?: string | null;
    preferredLang3?: string | null;
    industry?: string | null;
    primaryProgLang?: string | null;
    secondaryProgLang?: string | null;
    fontSize: string;
    hasPreferencesSet: boolean;
    disabledMcpRepoIds: string[];
  };
  error?: string;
}

export const GET = defineRoute({
  scope: 'GET /api/user/preferences',
  auth: 'user',
  handler: async ({ userId }) => {
    if (!userId) throw ApiError.unauthorized();

    const res = await callSidecar<UserPreferencesSidecarResponse>(
      '/v1/user/preferences/get',
      { userId },
      { label: 'user-preferences /v1/user/preferences/get' }
    );

    return ok(res.preferences ?? {
      hasPreferencesSet: false,
      fontSize: 'small',
      disabledMcpRepoIds: [],
      savedRepositories: [],
    });
  },
});

export const POST = defineRoute({
  scope: 'POST /api/user/preferences',
  auth: 'user',
  bodySchema: PreferencesBodySchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const { preferredLang1, preferredLang2, preferredLang3, industry, primaryProgLang, secondaryProgLang, fontSize, disabledMcpRepoIds } = body;

    const res = await callSidecar<UserPreferencesSetSidecarResponse>(
      '/v1/user/preferences/set',
      {
        userId,
        preferredLang1: preferredLang1 || null,
        preferredLang2: preferredLang2 || null,
        preferredLang3: preferredLang3 || null,
        industry: industry || null,
        primaryProgLang: primaryProgLang || null,
        secondaryProgLang: secondaryProgLang || null,
        fontSize: fontSize || 'small',
        disabledMcpRepoIds: Array.isArray(disabledMcpRepoIds) ? disabledMcpRepoIds : undefined,
        hasDisabledRepos: Array.isArray(disabledMcpRepoIds),
      },
      { label: 'user-preferences /v1/user/preferences/set' }
    );

    if (!res.ok) {
      throw ApiError.internal(res.error || 'Failed to update user preferences');
    }

    return ok({ user: res.user });
  },
});
