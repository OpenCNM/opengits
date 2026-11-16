import { z } from 'zod';

export const moduleTabKindSchema = z.enum(['doc', 'api', 'changelog', 'external']);
export type ModuleTabKind = z.infer<typeof moduleTabKindSchema>;

export const moduleTabSchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  kind: moduleTabKindSchema,
});
export type ModuleTab = z.infer<typeof moduleTabSchema>;

export const siteTopologyDecisionSchema = z.object({
  /** 核心教程/知识库的根路径前缀（爬虫主工作区） */
  primaryDocPrefix: z.string().default('/'),
  /** 是否存在独立的 1:1 API Reference（若有，关联到 Scalar 交互视窗） */
  apiReferenceUrl: z.string().nullable().optional(),
  /** 必须硬拦截的非文档类前缀（博客/归档/营销/价格等） */
  excludePrefixes: z.array(z.string()).default([]),
  /** 识别出的多 Tab 顶层维度（用于客户端顶部导航栏） */
  moduleTabs: z.array(moduleTabSchema).default([]),
  /** 从 CandidateNavBlocks 中选出的主侧栏目录区块 ID（如 "b2"，无侧栏则为空） */
  sidebarBlockId: z.string().max(32).optional(),
});

export type SiteTopologyDecision = z.infer<typeof siteTopologyDecisionSchema>;

// ── 导入作用域契约（确认页选择器 → 信封 → Go 爬虫）──

/** 作用域路径形态：站内绝对路径（/docs、/en/docs 等），禁外链与穿越 */
const scopePrefixSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\/[A-Za-z0-9/_.-]*$/, 'scope prefix must be an on-site absolute path');

/** 客户端回传 moduleTabs 的严校验形态（直落公共 repoProfile，防注入） */
export const moduleTabIngestSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  path: z.string().min(0).max(200),
  kind: moduleTabKindSchema,
});
export type ModuleTabIngest = z.infer<typeof moduleTabIngestSchema>;

export const WEB_DOC_SCOPE_MODES = ['recommended', 'all', 'custom'] as const;
export type WebDocScopeMode = (typeof WEB_DOC_SCOPE_MODES)[number];

/**
 * 作用域提交契约：UI 只提交 scopeMode/primary/allows/moduleTabs（excludes 为死数据，
 * 白名单天然排除未选模块；auto 模式 excludes 由 Go 内部裁决并随收敛点落盘）。
 * 字段集与不变量拆分导出，供 ingest 路由 merge 进完整 bodySchema（SSOT 不分叉）。
 */
export const webDocScopeFields = z.object({
  scopeMode: z.enum(['', ...WEB_DOC_SCOPE_MODES]).default(''),
  primaryDocPrefix: scopePrefixSchema.optional().default(''),
  allowedPrefixes: z.array(scopePrefixSchema).max(12).optional().default([]),
  moduleTabs: z.array(moduleTabIngestSchema).max(12).optional().default([]),
});

/** 单判据不变量：scopeMode 非空 ⇒ allows 非空；scopeMode 空 ⇒ 作用域字段全空 */
export function scopeParamsRefinement(
  val: z.infer<typeof webDocScopeFields>,
  ctx: z.RefinementCtx
): void {
  if (val.scopeMode !== '') {
    if (val.allowedPrefixes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedPrefixes'],
        message: 'explicit scope requires at least one allowed prefix',
      });
    }
  } else if (val.primaryDocPrefix !== '' || val.allowedPrefixes.length > 0 || val.moduleTabs.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeMode'],
      message: 'scope fields must be empty when scopeMode is empty',
    });
  }
}

export const webDocScopeParamsSchema = webDocScopeFields.superRefine(scopeParamsRefinement);

export type WebDocScopeParams = z.infer<typeof webDocScopeParamsSchema>;

/** 作用域比对键：前缀排序后拼接（点选顺序无关） */
export function scopeFingerprint(prefixes: readonly string[]): string {
  return [...prefixes].sort().join('|');
}

/**
 * 作用域一致性判定（复用/在途去重防漂移）：
 * 两侧均显式声明且不相等才判冲突；任一侧未声明（存量库/兜底提交）视为通配放行。
 */
export function scopeMatches(
  lhs: readonly string[] | undefined | null,
  rhs: readonly string[] | undefined | null
): boolean {
  const lhsEmpty = !lhs || lhs.length === 0;
  const rhsEmpty = !rhs || rhs.length === 0;
  if (lhsEmpty || rhsEmpty) return true; // 任一侧通配（全集 superset 语义）
  return scopeFingerprint(lhs) === scopeFingerprint(rhs);
}

/**
 * 确定性收敛漏斗（Deterministic Convergence Funnel）：
 * 规范化 LLM 产生的拓扑结构，纠正斜杠、无效字段与缺失属性，保障入库与爬虫执行 100% 幂等封闭。
 */
export function normalizeSiteTopologyDecision(raw: unknown): SiteTopologyDecision {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  let primaryDocPrefix = typeof obj.primaryDocPrefix === 'string' ? obj.primaryDocPrefix.trim() : '/';
  if (!primaryDocPrefix.startsWith('/')) {
    primaryDocPrefix = `/${primaryDocPrefix}`;
  }
  if (primaryDocPrefix.length > 1) {
    primaryDocPrefix = primaryDocPrefix.replace(/\/+$/, '');
  }

  const apiReferenceUrl =
    typeof obj.apiReferenceUrl === 'string' && obj.apiReferenceUrl.trim()
      ? obj.apiReferenceUrl.trim()
      : null;

  const rawExcludes = Array.isArray(obj.excludePrefixes) ? obj.excludePrefixes : [];
  const cleanExcludes: string[] = [];
  for (const item of rawExcludes) {
    if (typeof item === 'string') {
      let trimmed = item.trim();
      if (!trimmed || trimmed === '/') continue;
      if (!trimmed.startsWith('/')) trimmed = `/${trimmed}`;
      trimmed = trimmed.replace(/\/+$/, '');
      if (!cleanExcludes.includes(trimmed)) {
        cleanExcludes.push(trimmed);
      }
    }
  }

  const rawTabs = Array.isArray(obj.moduleTabs) ? obj.moduleTabs : [];
  const cleanTabs: ModuleTab[] = [];
  for (const item of rawTabs) {
    if (item && typeof item === 'object') {
      const t = item as Record<string, unknown>;
      const label = typeof t.label === 'string' ? t.label.trim() : '';
      if (!label) continue;

      let kind: ModuleTabKind = 'doc';
      const rawKind = typeof t.kind === 'string' ? t.kind.trim().toLowerCase() : '';
      if (rawKind === 'api' || rawKind === 'changelog' || rawKind === 'external') {
        kind = rawKind;
      }

      let id = typeof t.id === 'string' ? t.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') : '';
      if (!id) id = kind;

      const path = typeof t.path === 'string' ? t.path.trim() : '';
      cleanTabs.push({ id, label, path, kind });
    }
  }

  const sidebarBlockId =
    typeof obj.sidebarBlockId === 'string' ? obj.sidebarBlockId.trim().slice(0, 32) : '';

  return {
    primaryDocPrefix,
    apiReferenceUrl,
    excludePrefixes: cleanExcludes,
    moduleTabs: cleanTabs,
    ...(sidebarBlockId ? { sidebarBlockId } : {}),
  };
}

// ── Phase 4: 站点级未知容器骨架探测契约（仅角色声明，禁止正文改写）──

export const containerRoleSchema = z.enum(['card', 'callout', 'ignore']);
export type ContainerRole = z.infer<typeof containerRoleSchema>;

export const containerMappingRuleSchema = z.object({
  containerSelector: z.string().min(1).max(120),
  role: containerRoleSchema,
  calloutType: z
    .enum(['info', 'note', 'tip', 'check', 'important', 'warning', 'danger'])
    .optional()
    .default('info'),
  titleSelector: z.string().max(120).optional().default(''),
  eyebrowSelector: z.string().max(120).optional().default(''),
  bodySelector: z.string().max(120).optional().default(''),
  linkSelector: z.string().max(120).optional().default(''),
});
export type ContainerMappingRule = z.infer<typeof containerMappingRuleSchema>;

export const siteContainerProbeDecisionSchema = z.object({
  rules: z.array(containerMappingRuleSchema).max(6).default([]),
});
export type SiteContainerProbeDecision = z.infer<typeof siteContainerProbeDecisionSchema>;

function isQualifiedSelector(sel: string): boolean {
  if (!sel || sel.length > 120) return false;
  return sel
    .split(',')
    .every((part) => {
      const trimmed = part.trim();
      return Boolean(trimmed && (trimmed.includes('.') || trimmed.includes('[')));
    });
}

/** 确定性收敛漏斗：仅保留合法限定的容器选择器，拒绝通配裸标签 */
export function normalizeSiteContainerProbeDecision(raw: unknown): SiteContainerProbeDecision {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawRules = Array.isArray(obj.rules) ? obj.rules : [];
  const rules: ContainerMappingRule[] = [];

  for (const item of rawRules) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const sel = typeof r.containerSelector === 'string' ? r.containerSelector.trim() : '';
    // 必须具备 class(.) 或属性([]) 限定词，拒绝 *, body, main, div, a 及逗号混入的裸选择器
    if (!isQualifiedSelector(sel)) continue;

    const rawRole = typeof r.role === 'string' ? r.role.trim().toLowerCase() : '';
    if (rawRole !== 'card' && rawRole !== 'callout' && rawRole !== 'ignore') continue;

    const rawCalloutType = typeof r.calloutType === 'string' ? r.calloutType.trim().toLowerCase() : 'info';
    const validCalloutTypes = new Set(['info', 'note', 'tip', 'check', 'important', 'warning', 'danger']);
    const calloutType = (validCalloutTypes.has(rawCalloutType) ? rawCalloutType : 'info') as ContainerMappingRule['calloutType'];

    const trimSel = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 120) : '');
    rules.push({
      containerSelector: sel,
      role: rawRole,
      calloutType,
      titleSelector: trimSel(r.titleSelector),
      eyebrowSelector: trimSel(r.eyebrowSelector),
      bodySelector: trimSel(r.bodySelector),
      linkSelector: trimSel(r.linkSelector),
    });
    if (rules.length >= 6) break;
  }

  return { rules };
}
