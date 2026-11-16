import { z } from 'zod';

import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { ENGINE_CONFIG } from '@/lib/config';
import { callSidecar } from '@/lib/sidecar-client';
import { isPublicHttpEndpoint } from '@/lib/url-inspector';
import { normalizeSiteTopologyDecision } from '@/lib/schemas/webdoc-topology';

export const dynamic = 'force-dynamic';

/**
 * 拓扑探测薄代理（导入确认页 scout 数据源）：
 * Node 只做鉴权/限流/SSRF 预检与转发；HTML 抓取、DOM 骨架提取与 LLM 拓扑裁决
 * 全部收敛在 Go Sidecar `/v1/web-doc/topology`（Single-Writer，Node 零重复实现）。
 * Sidecar 内部预算 14s 扫描 + 8s LLM ⇒ 代理超时 25s 覆盖上界。
 */
export const POST = defineRoute({
  scope: 'POST /api/ingest/web-doc/scout',
  auth: 'user',
  rateLimit: {
    limit: ENGINE_CONFIG.rateLimit.webDocScoutMaxRequests,
    windowMs: ENGINE_CONFIG.rateLimit.webDocScoutWindowMs,
    identifier: ({ userId }) => `webdoc-scout:${userId ?? 'anonymous'}`,
  },
  bodySchema: z.object({
    url: z.string().min(1).max(2048),
    bypassCache: z.boolean().optional().default(false),
  }),
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();

    if (!isPublicHttpEndpoint(body.url)) {
      throw ApiError.badRequest('不允许探测内网、回环或云元数据地址', {
        code: 'PRIVATE_NETWORK_BLOCKED',
      });
    }

    try {
      const raw = await callSidecar<Record<string, unknown>>(
        '/v1/web-doc/topology',
        { url: body.url, userId, bypassCache: body.bypassCache },
        { label: 'webdoc-topology-scout', timeoutMs: 25_000 }
      );

      if (raw?.scoutStatus === 'scan_failed') {
        return ok({
          available: false,
          scoutStatus: 'scan_failed' as const,
          reason:
            typeof raw?.failureReason === 'string' && raw.failureReason.trim()
              ? raw.failureReason.trim()
              : 'landing page scan failed',
          naturalPrefix: typeof raw?.naturalPrefix === 'string' ? raw.naturalPrefix : '/',
          primaryDocPrefix: typeof raw?.primaryDocPrefix === 'string' ? raw.primaryDocPrefix : '/',
        });
      }

      // 确定性收敛漏斗：sidecar 产物在进入前端前完成幂等规范化
      const decision = normalizeSiteTopologyDecision({
        primaryDocPrefix: raw?.primaryDocPrefix,
        apiReferenceUrl: raw?.apiReferenceUrl,
        excludePrefixes: Array.isArray(raw?.excludePrefixes) ? raw.excludePrefixes : [],
        moduleTabs: Array.isArray(raw?.moduleTabs) ? raw.moduleTabs : [],
        sidebarBlockId: raw?.sidebarBlockId,
      });

      const scoutStatus: 'multi_module' | 'single_module' =
        raw?.scoutStatus === 'multi_module' || decision.moduleTabs.length >= 2
          ? 'multi_module'
          : 'single_module';

      return ok({
        available: true,
        scoutStatus,
        siteTitle: typeof raw?.siteTitle === 'string' ? raw.siteTitle : '',
        entryUrl: typeof raw?.entryUrl === 'string' ? raw.entryUrl : body.url,
        naturalPrefix: typeof raw?.naturalPrefix === 'string' ? raw.naturalPrefix : '/',
        candidatePrefixes: Array.isArray(raw?.candidatePrefixes) ? raw.candidatePrefixes : [],
        // 展示型数据轻清洗（服务端产物，不入 ingest 提交契约）
        sidebarHeadings: Array.isArray(raw?.sidebarHeadings)
          ? raw.sidebarHeadings
              .filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
              .map((h) => h.trim().slice(0, 120))
              .slice(0, 10)
          : [],
        ...decision,
      });
    } catch (err) {
      // Fail-Closed：sidecar 离线/超时时不在 Node 侧猜测拓扑（零重复实现），
      // 前端按「scan_failed」显式告知；用户此时提交则 scopeMode='' 走 Go 自动裁决兜底
      return ok({
        available: false,
        scoutStatus: 'scan_failed' as const,
        reason: err instanceof Error ? err.message : 'sidecar unreachable',
      });
    }
  },
});
