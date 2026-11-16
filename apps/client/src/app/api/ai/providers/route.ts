import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { AI_PROVIDER_PRESETS } from '@/lib/constants';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { captureError } from '@/lib/observability/errors';

export const dynamic = 'force-dynamic';

function presetProviders() {
  return Object.values(AI_PROVIDER_PRESETS).map((p, idx) => ({
    id: p.id,
    providerKey: p.id,
    name: p.name,
    label: p.label,
    badgeLabel: p.badgeLabel,
    baseUrl: p.baseUrl,
    apiFormat: p.apiFormat,
    defaultModel: p.defaultModel,
    models: p.models,
    isDefault: p.id === 'google',
    displayOrder: idx,
  }));
}

async function loadEnabledProviders() {
  let providers = await prisma.globalModelProvider.findMany({
    where: { isEnabled: true },
    orderBy: { displayOrder: 'asc' },
  });

  // Auto-seed if database has no providers yet
  if (providers.length === 0) {
    const presets = Object.values(AI_PROVIDER_PRESETS);
    for (let i = 0; i < presets.length; i++) {
      const p = presets[i];
      await prisma.globalModelProvider.upsert({
        where: { providerKey: p.id },
        create: {
          providerKey: p.id,
          name: p.name,
          label: p.label,
          badgeLabel: p.badgeLabel,
          baseUrl: p.baseUrl,
          apiFormat: p.apiFormat,
          defaultModel: p.defaultModel,
          models: p.models,
          isEnabled: true,
          isDefault: p.id === 'google',
          displayOrder: i,
        },
        update: {},
      });
    }

    providers = await prisma.globalModelProvider.findMany({
      where: { isEnabled: true },
      orderBy: { displayOrder: 'asc' },
    });
  }

  return providers;
}

/**
 * GET /api/ai/providers —— 动态服务商目录（公开端点）。
 * DB 不可达时降级为静态 presets（fallback:true 标记），保证客户端永远拿得到可选列表，
 * 因此这里不走 defineRoute 的统一 500 通道，降级分支用 NextResponse 透传。
 */
export const GET = defineRoute({
  scope: 'GET /api/ai/providers',
  auth: 'public',
  handler: async () => {
    try {
      const providers = await loadEnabledProviders();
      return ok({
        fallback: false,
        providers: providers.map((p) => ({
          id: p.id,
          providerKey: p.providerKey,
          name: p.name,
          label: p.label,
          badgeLabel: p.badgeLabel,
          baseUrl: p.baseUrl,
          apiFormat: p.apiFormat,
          defaultModel: p.defaultModel,
          models: p.models,
          isDefault: p.isDefault,
          displayOrder: p.displayOrder,
        })),
      });
    } catch (error) {
      await captureError(error, { scope: 'GET /api/ai/providers' });
      return NextResponse.json({
        success: true as const,
        data: { fallback: true, providers: presetProviders() },
      });
    }
  },
});
