import { describe, expect, it } from 'vitest';

import {
  chipModules,
  defaultSelectedPaths,
  buildScopePayload,
} from '@/lib/import-wizard/webdoc-scope';
import {
  webDocScopeParamsSchema,
  scopeMatches,
  scopeFingerprint,
  type ModuleTab,
} from '@/lib/schemas/webdoc-topology';

const tab = (id: string, label: string, path: string, kind: ModuleTab['kind']): ModuleTab => ({
  id,
  label,
  path,
  kind,
});

const eveTabs: ModuleTab[] = [
  tab('docs', 'Docs', '/docs', 'doc'),
  tab('integrations', 'Integrations', '/integrations', 'doc'),
  tab('changelog', 'Changelog', '/changelog', 'changelog'),
  tab('deploy', 'Deploy', 'https://vercel.com/eve', 'external'),
  tab('root', 'Home', '/', 'doc'),
  tab('blog', 'Blog', '', 'doc'),
];

describe('chipModules — 站内可交互 Chip 过滤', () => {
  it('keeps on-site tabs with real paths and drops external/empty/root-only', () => {
    const chips = chipModules(eveTabs);
    expect(chips.map((c) => c.path)).toEqual(['/docs', '/integrations', '/changelog']);
  });
});

describe('defaultSelectedPaths — 默认勾选集', () => {
  it('selects doc/api modules under the recommended prefix and excludes changelog', () => {
    const chips = chipModules(eveTabs);
    expect(defaultSelectedPaths('/docs', chips)).toEqual(['/docs']);
  });

  it('selects everything doc/api when primary is root', () => {
    const chips = chipModules(eveTabs);
    expect(defaultSelectedPaths('/', chips)).toEqual(['/docs', '/integrations']);
  });

  it('falls back to the first chip when nothing matches the prefix', () => {
    const chips = chipModules(eveTabs);
    expect(defaultSelectedPaths('/guide', chips)).toEqual(['/docs']);
  });

  it('returns empty for empty chips', () => {
    expect(defaultSelectedPaths('/docs', [])).toEqual([]);
  });
});

describe('buildScopePayload — UI 状态到提交载荷的单一出口', () => {
  const readyTabs = eveTabs;

  it('emits scopeMode="" auto fallback when scout is not ready (zero regression)', () => {
    expect(
      buildScopePayload({ mode: 'recommended', primaryDocPrefix: '', selectedPaths: [], moduleTabs: [] })
    ).toEqual({ scopeMode: '', primaryDocPrefix: '', allowedPrefixes: [], moduleTabs: [] });
  });

  it('emits all-mode payload with root allow-everything', () => {
    const payload = buildScopePayload({
      mode: 'all',
      primaryDocPrefix: '/docs',
      selectedPaths: ['/docs'],
      moduleTabs: readyTabs,
    });
    expect(payload.scopeMode).toBe('all');
    expect(payload.primaryDocPrefix).toBe('/');
    expect(payload.allowedPrefixes).toEqual(['/']);
    // moduleTabs 全量透传（多 Tab 隔离元数据持久化，能力不倒退）
    expect(payload.moduleTabs).toBe(readyTabs);
  });

  it('derives recommended when selection equals the default set', () => {
    const payload = buildScopePayload({
      mode: 'recommended',
      primaryDocPrefix: '/docs',
      selectedPaths: defaultSelectedPaths('/docs', chipModules(readyTabs)),
      moduleTabs: readyTabs,
    });
    expect(payload.scopeMode).toBe('recommended');
    expect(payload.allowedPrefixes).toEqual(['/docs']);
  });

  it('derives custom when the user adds an extra module', () => {
    const payload = buildScopePayload({
      mode: 'recommended',
      primaryDocPrefix: '/docs',
      selectedPaths: ['/docs', '/integrations'],
      moduleTabs: readyTabs,
    });
    expect(payload.scopeMode).toBe('custom');
    expect(payload.allowedPrefixes).toEqual(['/docs', '/integrations']);
    expect(payload.primaryDocPrefix).toBe('/docs');
  });

  it('falls back to default selection when selectedPaths is empty but scout is ready', () => {
    const payload = buildScopePayload({
      mode: 'recommended',
      primaryDocPrefix: '/docs',
      selectedPaths: [],
      moduleTabs: readyTabs,
    });
    expect(payload.scopeMode).toBe('recommended');
    expect(payload.allowedPrefixes).toEqual(['/docs']);
  });

  it('falls back to primaryDocPrefix for single_module sites without chips so schema invariant holds', () => {
    const payload = buildScopePayload({
      mode: 'recommended',
      primaryDocPrefix: '/ui/docs',
      selectedPaths: [],
      moduleTabs: [],
    });
    expect(payload).toEqual({
      scopeMode: 'recommended',
      primaryDocPrefix: '/ui/docs',
      allowedPrefixes: ['/ui/docs'],
      moduleTabs: [],
    });
    expect(webDocScopeParamsSchema.safeParse(payload).success).toBe(true);
  });
});

describe('scopeMatches — 复用/在途去重作用域核验', () => {
  it('treats any undefined/empty side as wildcard (legacy repos, auto submissions)', () => {
    expect(scopeMatches(['/docs'], undefined)).toBe(true);
    expect(scopeMatches(undefined, ['/docs'])).toBe(true);
    expect(scopeMatches([], ['/docs'])).toBe(true);
    expect(scopeMatches(['/docs'], [])).toBe(true);
  });

  it('is order-insensitive via sorted fingerprint', () => {
    expect(scopeFingerprint(['/docs', '/integrations'])).toBe(
      scopeFingerprint(['/integrations', '/docs'])
    );
    expect(scopeMatches(['/docs', '/integrations'], ['/integrations', '/docs'])).toBe(true);
  });

  it('rejects genuinely different scopes (409 path)', () => {
    expect(scopeMatches(['/docs'], ['/docs', '/integrations'])).toBe(false);
    expect(scopeMatches(['/docs'], ['/'])).toBe(false);
  });
});

describe('webDocScopeParamsSchema — 单判据不变量', () => {
  it('accepts explicit scope with non-empty allowedPrefixes', () => {
    const res = webDocScopeParamsSchema.safeParse({
      scopeMode: 'custom',
      primaryDocPrefix: '/docs',
      allowedPrefixes: ['/docs', '/integrations'],
      moduleTabs: [{ id: 'docs', label: 'Docs', path: '/docs', kind: 'doc' }],
    });
    expect(res.success).toBe(true);
  });

  it('rejects explicit scope with empty allowedPrefixes (fail-fast 400)', () => {
    const res = webDocScopeParamsSchema.safeParse({
      scopeMode: 'recommended',
      primaryDocPrefix: '/docs',
      allowedPrefixes: [],
      moduleTabs: [],
    });
    expect(res.success).toBe(false);
  });

  it('rejects scope fields leaking into auto mode', () => {
    const res = webDocScopeParamsSchema.safeParse({
      scopeMode: '',
      primaryDocPrefix: '/docs',
      allowedPrefixes: [],
      moduleTabs: [],
    });
    expect(res.success).toBe(false);
  });

  it('rejects off-site absolute URL prefixes', () => {
    const res = webDocScopeParamsSchema.safeParse({
      scopeMode: 'custom',
      primaryDocPrefix: '/docs',
      allowedPrefixes: ['https://evil.example.com'],
      moduleTabs: [],
    });
    expect(res.success).toBe(false);
  });

  it('caps moduleTabs array at 12 and enforces closed kind enum', () => {
    const tabs = Array.from({ length: 13 }, (_, i) => ({
      id: `t${i}`,
      label: `T${i}`,
      path: `/t${i}`,
      kind: 'doc',
    }));
    const res = webDocScopeParamsSchema.safeParse({
      scopeMode: 'custom',
      primaryDocPrefix: '/docs',
      allowedPrefixes: ['/docs'],
      moduleTabs: tabs,
    });
    expect(res.success).toBe(false);

    const badKind = webDocScopeParamsSchema.safeParse({
      scopeMode: 'custom',
      primaryDocPrefix: '/docs',
      allowedPrefixes: ['/docs'],
      moduleTabs: [{ id: 'x', label: 'X', path: '/x', kind: 'malicious' }],
    });
    expect(badKind.success).toBe(false);
  });
});
