import { describe, expect, it } from 'vitest';
import { chipModules, defaultSelectedPaths, buildScopePayload } from '@/lib/import-wizard/webdoc-scope';
import {
  webDocScopeParamsSchema,
  scopeMatches,
  scopeFingerprint,
  type ModuleTab,
  siteTopologyDecisionSchema,
  normalizeSiteTopologyDecision,
  containerMappingRuleSchema,
  siteContainerProbeDecisionSchema,
  normalizeSiteContainerProbeDecision,
} from '@/lib/schemas/webdoc-topology';
import { ALL_PROMPT_PRESETS } from '@/lib/prompt-presets';

describe('webdoc-scope', () => {
  const tab = (id: string, label: string, path: string, kind: ModuleTab['kind']): ModuleTab => ({ id, label, path, kind });
  const eveTabs: ModuleTab[] = [
    tab('docs', 'Docs', '/docs', 'doc'),
    tab('integrations', 'Integrations', '/integrations', 'doc'),
    tab('changelog', 'Changelog', '/changelog', 'changelog'),
    tab('deploy', 'Deploy', 'https://vercel.com/eve', 'external'),
    tab('root', 'Home', '/', 'doc'),
    tab('blog', 'Blog', '', 'doc'),
  ];

  it('chipModules & defaultSelectedPaths 过滤站内可交互模块与默认勾选集', () => {
    const chips = chipModules(eveTabs);
    expect(chips.map((c) => c.path)).toEqual(['/docs', '/integrations', '/changelog']);
    expect(defaultSelectedPaths('/docs', chips)).toEqual(['/docs']);
    expect(defaultSelectedPaths('/', chips)).toEqual(['/docs', '/integrations']);
    expect(defaultSelectedPaths('/guide', chips)).toEqual(['/docs']);
    expect(defaultSelectedPaths('/docs', [])).toEqual([]);
  });

  it('buildScopePayload 覆盖未就绪/all/recommended/custom/空选/单模块回退', () => {
    expect(buildScopePayload({ mode: 'recommended', primaryDocPrefix: '', selectedPaths: [], moduleTabs: [] })).toEqual({
      scopeMode: '',
      primaryDocPrefix: '',
      allowedPrefixes: [],
      moduleTabs: [],
    });

    const allPayload = buildScopePayload({ mode: 'all', primaryDocPrefix: '/docs', selectedPaths: ['/docs'], moduleTabs: eveTabs });
    expect([allPayload.scopeMode, allPayload.primaryDocPrefix, allPayload.allowedPrefixes, allPayload.moduleTabs]).toEqual([
      'all',
      '/',
      ['/'],
      eveTabs,
    ]);

    const recPayload = buildScopePayload({
      mode: 'recommended',
      primaryDocPrefix: '/docs',
      selectedPaths: defaultSelectedPaths('/docs', chipModules(eveTabs)),
      moduleTabs: eveTabs,
    });
    expect([recPayload.scopeMode, recPayload.allowedPrefixes]).toEqual(['recommended', ['/docs']]);

    const customPayload = buildScopePayload({
      mode: 'recommended',
      primaryDocPrefix: '/docs',
      selectedPaths: ['/docs', '/integrations'],
      moduleTabs: eveTabs,
    });
    expect([customPayload.scopeMode, customPayload.allowedPrefixes]).toEqual(['custom', ['/docs', '/integrations']]);

    const emptySelPayload = buildScopePayload({ mode: 'recommended', primaryDocPrefix: '/docs', selectedPaths: [], moduleTabs: eveTabs });
    expect([emptySelPayload.scopeMode, emptySelPayload.allowedPrefixes]).toEqual(['recommended', ['/docs']]);

    const singleMod = buildScopePayload({ mode: 'recommended', primaryDocPrefix: '/ui/docs', selectedPaths: [], moduleTabs: [] });
    expect(singleMod).toEqual({ scopeMode: 'recommended', primaryDocPrefix: '/ui/docs', allowedPrefixes: ['/ui/docs'], moduleTabs: [] });
    expect(webDocScopeParamsSchema.safeParse(singleMod).success).toBe(true);
  });

  it('scopeMatches & webDocScopeParamsSchema 作用域指纹与单判据不变量', () => {
    expect(scopeMatches(['/docs'], undefined)).toBe(true);
    expect(scopeMatches(undefined, ['/docs'])).toBe(true);
    expect(scopeMatches([], ['/docs'])).toBe(true);
    expect(scopeFingerprint(['/docs', '/integrations'])).toBe(scopeFingerprint(['/integrations', '/docs']));
    expect(scopeMatches(['/docs', '/integrations'], ['/integrations', '/docs'])).toBe(true);
    expect(scopeMatches(['/docs'], ['/docs', '/integrations'])).toBe(false);
    expect(scopeMatches(['/docs'], ['/'])).toBe(false);

    expect(
      webDocScopeParamsSchema.safeParse({
        scopeMode: 'custom',
        primaryDocPrefix: '/docs',
        allowedPrefixes: ['/docs', '/integrations'],
        moduleTabs: [{ id: 'docs', label: 'Docs', path: '/docs', kind: 'doc' }],
      }).success
    ).toBe(true);
    expect(
      webDocScopeParamsSchema.safeParse({ scopeMode: 'recommended', primaryDocPrefix: '/docs', allowedPrefixes: [], moduleTabs: [] }).success
    ).toBe(false);
    expect(
      webDocScopeParamsSchema.safeParse({ scopeMode: '', primaryDocPrefix: '/docs', allowedPrefixes: [], moduleTabs: [] }).success
    ).toBe(false);
    expect(
      webDocScopeParamsSchema.safeParse({ scopeMode: 'custom', primaryDocPrefix: '/docs', allowedPrefixes: ['https://evil.example.com'], moduleTabs: [] }).success
    ).toBe(false);
    expect(
      webDocScopeParamsSchema.safeParse({
        scopeMode: 'custom',
        primaryDocPrefix: '/docs',
        allowedPrefixes: ['/docs'],
        moduleTabs: Array.from({ length: 13 }, (_, i) => ({ id: `t${i}`, label: `T${i}`, path: `/t${i}`, kind: 'doc' })),
      }).success
    ).toBe(false);
    expect(
      webDocScopeParamsSchema.safeParse({
        scopeMode: 'custom',
        primaryDocPrefix: '/docs',
        allowedPrefixes: ['/docs'],
        moduleTabs: [{ id: 'x', label: 'X', path: '/x', kind: 'malicious' }],
      }).success
    ).toBe(false);
  });
});

describe('webdoc-topology', () => {
  it('siteTopologyDecisionSchema & normalizeSiteTopologyDecision 确定性收敛漏斗', () => {
    const parsed = siteTopologyDecisionSchema.parse({
      primaryDocPrefix: '/docs',
      apiReferenceUrl: '/api',
      excludePrefixes: ['/changelog', '/benchmarks'],
      moduleTabs: [
        { id: 'docs', label: 'Docs', path: '/docs', kind: 'doc' },
        { id: 'api', label: 'API Reference', path: '/api', kind: 'api' },
      ],
    });
    expect(parsed.primaryDocPrefix).toBe('/docs');
    expect(siteTopologyDecisionSchema.parse({}).primaryDocPrefix).toBe('/');

    expect(normalizeSiteTopologyDecision({ primaryDocPrefix: 'docs/getting-started/' }).primaryDocPrefix).toBe('/docs/getting-started');
    expect(normalizeSiteTopologyDecision({ primaryDocPrefix: '/' }).primaryDocPrefix).toBe('/');
    expect(normalizeSiteTopologyDecision({ excludePrefixes: ['changelog/', '/benchmarks', '', '/', 'changelog', '/pricing/'] }).excludePrefixes).toEqual([
      '/changelog',
      '/benchmarks',
      '/pricing',
    ]);

    const normTabs = normalizeSiteTopologyDecision({
      moduleTabs: [
        { label: 'Documentation', path: '/docs', kind: 'doc' },
        { id: 'custom-api', label: 'API Reference', path: '/api', kind: 'api' },
        { id: 'updates', label: 'Changelog', path: '/changelog', kind: 'changelog' },
        { label: 'Community', path: 'https://discord.gg', kind: 'external' },
        { label: 'Unknown Kind Tab', path: '/other', kind: 'invalid_kind' as any },
        { label: '   ', path: '/blank' },
      ],
    });
    expect(normTabs.moduleTabs).toHaveLength(5);
    expect(normTabs.moduleTabs[0]).toEqual({ id: 'doc', label: 'Documentation', path: '/docs', kind: 'doc' });
    expect(normTabs.moduleTabs[4]).toEqual({ id: 'doc', label: 'Unknown Kind Tab', path: '/other', kind: 'doc' });

    expect(normalizeSiteTopologyDecision(null)).toEqual({
      primaryDocPrefix: '/',
      apiReferenceUrl: null,
      excludePrefixes: [],
      moduleTabs: [],
    });
    expect(normalizeSiteTopologyDecision({ primaryDocPrefix: '/ui/docs', sidebarBlockId: ' b2 ' }).sidebarBlockId).toBe('b2');
  });

  it('webdoc_topology_scout Prompt 编排与 BYOK Fail-Closed', async () => {
    const { PromptRegistry } = await import('@/lib/prompt-registry');
    const compiled = await PromptRegistry.getCompiledPrompt('webdoc_topology_scout', {
      entryUrl: 'https://eve.dev/docs/getting-started',
      siteTitle: 'eve - Build production AI agents',
      headerLinksText: '- [Docs](/docs/getting-started)\n- [API Reference](/api)',
      candidatePrefixesText: '- /docs\n- /api',
    });
    expect(compiled.compiledPrompt).toContain('https://eve.dev/docs/getting-started');
    expect(compiled.compiledPrompt).toContain('primaryDocPrefix');

    const { lookupLlmPurpose } = await import('@/lib/llm-gateway/registry');
    const prompt = await lookupLlmPurpose('webdoc_topology_scout')!.compile({
      entryUrl: 'https://coss.com/ui/docs',
      siteTitle: 'Introduction - coss ui',
      headerLinks: [{ text: 'Docs', href: '/ui/docs' }],
      candidatePrefixes: ['/ui', '/ui/docs'],
      navBlocks: [{ id: 'b2', regionHint: 'outside_main', linkCount: 42, sampleLinks: [{ text: 'Button', href: '/ui/docs/components/button' }] }],
    });
    expect(prompt).toContain('block b2');
    expect(prompt).toContain('sidebarBlockId');

    const { resolveCascadeCandidates, UserKeyUnavailableError } = await import('@/lib/llm-gateway/service');
    await expect(resolveCascadeCandidates('webdoc_topology_scout', null)).rejects.toBeInstanceOf(UserKeyUnavailableError);
  });

  it('Phase 4 webdoc_container_probe schema, normalizer & prompt preset', () => {
    const parsed = siteContainerProbeDecisionSchema.parse({
      rules: [
        { containerSelector: 'div.bento-tile, div', role: 'card', titleSelector: '.bento-heading' },
        { containerSelector: 'div.bento-tile, *', role: 'card', titleSelector: '.bento-heading' },
        { containerSelector: 'div.bento-tile', role: 'card', titleSelector: '.bento-heading', bodySelector: '.bento-desc', linkSelector: '.bento-cta' },
      ],
    });
    const normalized = normalizeSiteContainerProbeDecision(parsed);
    expect(normalized.rules).toHaveLength(1);
    expect(normalized.rules[0].containerSelector).toBe('div.bento-tile');

    const rule = containerMappingRuleSchema.parse({
      containerSelector: ' [data-callout-box] ',
      role: 'callout',
      calloutType: 'warning',
      titleSelector: ' .title ',
      bodySelector: ' .body ',
    });
    expect(normalizeSiteContainerProbeDecision({ rules: [rule] }).rules[0]).toMatchObject({
      containerSelector: '[data-callout-box]',
      role: 'callout',
      calloutType: 'warning',
      titleSelector: '.title',
      bodySelector: '.body',
    });

    const preset = ALL_PROMPT_PRESETS.find((p) => p.key === 'webdoc_container_probe');
    expect(preset?.module).toBe('webdoc');
    expect(preset?.promptSchema.taskDescription).toContain('{{skeletonsText}}');
  });
});
