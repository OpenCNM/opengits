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
  primaryDocPrefix: z.string().default('/'),
  apiReferenceUrl: z.string().nullable().optional(),
  excludePrefixes: z.array(z.string()).default([]),
  moduleTabs: z.array(moduleTabSchema).default([]),
  sidebarBlockId: z.string().max(32).optional(),
});

export type SiteTopologyDecision = z.infer<typeof siteTopologyDecisionSchema>;

const scopePrefixSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\/[A-Za-z0-9/_.-]*$/, 'scope prefix must be an on-site absolute path');

export const moduleTabIngestSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  path: z.string().min(0).max(200),
  kind: moduleTabKindSchema,
});
export type ModuleTabIngest = z.infer<typeof moduleTabIngestSchema>;

export const WEB_DOC_SCOPE_MODES = ['recommended', 'all', 'custom'] as const;
export type WebDocScopeMode = (typeof WEB_DOC_SCOPE_MODES)[number];

export const webDocScopeFields = z.object({
  scopeMode: z.enum(['', ...WEB_DOC_SCOPE_MODES]).default(''),
  primaryDocPrefix: scopePrefixSchema.optional().default(''),
  allowedPrefixes: z.array(scopePrefixSchema).max(12).optional().default([]),
  moduleTabs: z.array(moduleTabIngestSchema).max(12).optional().default([]),
});

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

export function scopeFingerprint(prefixes: readonly string[]): string {
  return [...prefixes].sort().join('|');
}

export function scopeMatches(
  lhs: readonly string[] | undefined | null,
  rhs: readonly string[] | undefined | null
): boolean {
  const lhsEmpty = !lhs || lhs.length === 0;
  const rhsEmpty = !rhs || rhs.length === 0;
  if (lhsEmpty || rhsEmpty) return true;
  return scopeFingerprint(lhs) === scopeFingerprint(rhs);
}

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

export function normalizeSiteContainerProbeDecision(raw: unknown): SiteContainerProbeDecision {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawRules = Array.isArray(obj.rules) ? obj.rules : [];
  const rules: ContainerMappingRule[] = [];

  for (const item of rawRules) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const sel = typeof r.containerSelector === 'string' ? r.containerSelector.trim() : '';
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
