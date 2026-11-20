import { describe, it, expect } from 'vitest';
import {
  siteTopologyDecisionSchema,
  normalizeSiteTopologyDecision,
  containerMappingRuleSchema,
  siteContainerProbeDecisionSchema,
  normalizeSiteContainerProbeDecision,
} from '@/lib/schemas/webdoc-topology';
import { ALL_PROMPT_PRESETS } from '@/lib/prompt-presets';

describe('WebDoc Topology Decision Schema & Normalizer', () => {
  it('parses valid topology decision with strict schema', () => {
    const raw = {
      primaryDocPrefix: '/docs',
      apiReferenceUrl: '/api',
      excludePrefixes: ['/changelog', '/benchmarks'],
      moduleTabs: [
        { id: 'docs', label: 'Docs', path: '/docs', kind: 'doc' },
        { id: 'api', label: 'API Reference', path: '/api', kind: 'api' },
        { id: 'changelog', label: 'Changelog', path: '/changelog', kind: 'changelog' },
      ],
    };

    const parsed = siteTopologyDecisionSchema.parse(raw);
    expect(parsed.primaryDocPrefix).toBe('/docs');
    expect(parsed.apiReferenceUrl).toBe('/api');
    expect(parsed.excludePrefixes).toEqual(['/changelog', '/benchmarks']);
    expect(parsed.moduleTabs).toHaveLength(3);
    expect(parsed.moduleTabs[0].kind).toBe('doc');
  });

  it('provides safe defaults when given empty input', () => {
    const parsed = siteTopologyDecisionSchema.parse({});
    expect(parsed.primaryDocPrefix).toBe('/');
    expect(parsed.excludePrefixes).toEqual([]);
    expect(parsed.moduleTabs).toEqual([]);
  });

  describe('normalizeSiteTopologyDecision (Deterministic Convergence Funnel)', () => {
    it('normalizes primaryDocPrefix missing leading slash and trailing slash', () => {
      const res = normalizeSiteTopologyDecision({
        primaryDocPrefix: 'docs/getting-started/',
      });
      expect(res.primaryDocPrefix).toBe('/docs/getting-started');
    });

    it('keeps root slash intact', () => {
      const res = normalizeSiteTopologyDecision({
        primaryDocPrefix: '/',
      });
      expect(res.primaryDocPrefix).toBe('/');
    });

    it('cleans and normalizes excludePrefixes', () => {
      const res = normalizeSiteTopologyDecision({
        excludePrefixes: [
          'changelog/',
          '/benchmarks',
          '',
          '/',
          'changelog', // duplicate
          '/pricing/',
        ],
      });
      expect(res.excludePrefixes).toEqual(['/changelog', '/benchmarks', '/pricing']);
    });

    it('normalizes moduleTabs and fixes invalid kinds and missing IDs', () => {
      const res = normalizeSiteTopologyDecision({
        moduleTabs: [
          { label: 'Documentation', path: '/docs', kind: 'doc' }, // missing id
          { id: 'custom-api', label: 'API Reference', path: '/api', kind: 'api' },
          { id: 'updates', label: 'Changelog', path: '/changelog', kind: 'changelog' },
          { label: 'Community', path: 'https://discord.gg', kind: 'external' },
          { label: 'Unknown Kind Tab', path: '/other', kind: 'invalid_kind' as any },
          { label: '   ', path: '/blank' }, // empty label should be filtered out
        ],
      });

      expect(res.moduleTabs).toHaveLength(5);
      expect(res.moduleTabs[0]).toEqual({
        id: 'doc',
        label: 'Documentation',
        path: '/docs',
        kind: 'doc',
      });
      expect(res.moduleTabs[1]).toEqual({
        id: 'custom-api',
        label: 'API Reference',
        path: '/api',
        kind: 'api',
      });
      expect(res.moduleTabs[2]).toEqual({
        id: 'updates',
        label: 'Changelog',
        path: '/changelog',
        kind: 'changelog',
      });
      expect(res.moduleTabs[3]).toEqual({
        id: 'external',
        label: 'Community',
        path: 'https://discord.gg',
        kind: 'external',
      });
      expect(res.moduleTabs[4]).toEqual({
        id: 'doc',
        label: 'Unknown Kind Tab',
        path: '/other',
        kind: 'doc',
      });
    });

    it('handles null/undefined/non-object gracefully (fail-closed)', () => {
      const res = normalizeSiteTopologyDecision(null);
      expect(res).toEqual({
        primaryDocPrefix: '/',
        apiReferenceUrl: null,
        excludePrefixes: [],
        moduleTabs: [],
      });
    });

    it('preserves valid sidebarBlockId and omits when empty', () => {
      const res = normalizeSiteTopologyDecision({
        primaryDocPrefix: '/ui/docs',
        sidebarBlockId: ' b2 ',
      });
      expect(res.sidebarBlockId).toBe('b2');
      expect(siteTopologyDecisionSchema.parse({ primaryDocPrefix: '/ui/docs', sidebarBlockId: 'b2' }).sidebarBlockId).toBe('b2');
    });
  });

  describe('webdoc_topology_scout Prompt Preset & Compile Function', () => {
    it('compiles prompt successfully with navigation tuples', async () => {
      const { PromptRegistry } = await import('@/lib/prompt-registry');
      const compiled = await PromptRegistry.getCompiledPrompt('webdoc_topology_scout', {
        entryUrl: 'https://eve.dev/docs/getting-started',
        siteTitle: 'eve - Build production AI agents',
        headerLinksText: '- [Docs](/docs/getting-started)\n- [API Reference](/api)\n- [Changelog](/changelog)',
        candidatePrefixesText: '- /docs\n- /api\n- /changelog\n- /benchmarks',
      });

      expect(compiled.compiledPrompt).toContain('https://eve.dev/docs/getting-started');
      expect(compiled.compiledPrompt).toContain('eve - Build production AI agents');
      expect(compiled.compiledPrompt).toContain('- [API Reference](/api)');
      expect(compiled.compiledPrompt).toContain('primaryDocPrefix');
      expect(compiled.compiledPrompt).toContain('excludePrefixes');
      expect(compiled.compiledPrompt).toContain('moduleTabs');

      const preset = ALL_PROMPT_PRESETS.find((p) => p.key === 'webdoc_topology_scout');
      expect(preset?.promptSchema.taskDescription).toContain('{{navBlocksText}}');
      expect(preset?.promptSchema.taskDescription).toContain('sidebarBlockId');
    });

    it('gateway compile injects navBlocksText and sidebarBlockId instruction even if DB preset is older', async () => {
      const { lookupLlmPurpose } = await import('@/lib/llm-gateway/registry');
      const def = lookupLlmPurpose('webdoc_topology_scout');
      expect(def).toBeDefined();
      const prompt = await def!.compile({
        entryUrl: 'https://coss.com/ui/docs',
        siteTitle: 'Introduction - coss ui',
        headerLinks: [
          { text: 'Docs', href: '/ui/docs' },
          { text: 'Particles', href: '/ui/particles' },
        ],
        candidatePrefixes: ['/ui', '/ui/docs', '/ui/particles'],
        navBlocks: [
          {
            id: 'b2',
            regionHint: 'outside_main',
            linkCount: 42,
            sampleLinks: [
              { text: 'Introduction', href: '/ui/docs' },
              { text: 'Button', href: '/ui/docs/components/button' },
            ],
          },
        ],
      });
      expect(prompt).toContain('block b2');
      expect(prompt).toContain('sidebarBlockId');
      expect(prompt).toContain('/ui/docs/components/button');
    });

    it('fail-closes for BYOK webdoc_topology_scout when no userId is provided (2026-11 A 类收口)', async () => {
      const { resolveCascadeCandidates, UserKeyUnavailableError } = await import('@/lib/llm-gateway/service');
      await expect(resolveCascadeCandidates('webdoc_topology_scout', null)).rejects.toBeInstanceOf(
        UserKeyUnavailableError
      );
      // keyOrigin='user' 的 purpose 无 userId 绝不回落平台级联（伪弹性收口）
      await expect(resolveCascadeCandidates('webdoc_topology_scout', null)).rejects.toThrow(
        /keyOrigin=user/
      );
    });
  });

  describe('Tab URL Resolution against originalUrl', () => {
    function resolveUpstreamUrl(path: string | undefined, originalUrl?: string): string {
      if (!path) return originalUrl || '#';
      if (path.startsWith('http://') || path.startsWith('https://')) {
        return path;
      }
      if (originalUrl) {
        try {
          return new URL(path, originalUrl).href;
        } catch {
          return path;
        }
      }
      return path;
    }

    it('resolves relative changelog and pricing paths against upstream originalUrl', () => {
      const originalUrl = 'https://eve.dev/docs/getting-started';
      expect(resolveUpstreamUrl('/changelog', originalUrl)).toBe('https://eve.dev/changelog');
      expect(resolveUpstreamUrl('/pricing', originalUrl)).toBe('https://eve.dev/pricing');
      expect(resolveUpstreamUrl('benchmarks', originalUrl)).toBe('https://eve.dev/docs/benchmarks');
    });

    it('preserves full absolute URLs intact', () => {
      expect(resolveUpstreamUrl('https://discord.gg/eve', 'https://eve.dev')).toBe('https://discord.gg/eve');
    });

    it('falls back safely when originalUrl is missing', () => {
      expect(resolveUpstreamUrl('/changelog', undefined)).toBe('/changelog');
      expect(resolveUpstreamUrl(undefined, undefined)).toBe('#');
    });
  });

  describe('Phase 4 webdoc_container_probe schema, normalizer & prompt preset', () => {
    it('rejects comma-separated bare tag or wildcard bypasses in containerSelector', () => {
      const parsed = siteContainerProbeDecisionSchema.parse({
        rules: [
          {
            containerSelector: 'div.bento-tile, div',
            role: 'card',
            titleSelector: '.bento-heading',
          },
          {
            containerSelector: 'div.bento-tile, *',
            role: 'card',
            titleSelector: '.bento-heading',
          },
          {
            containerSelector: 'div.bento-tile',
            role: 'card',
            titleSelector: '.bento-heading',
            bodySelector: '.bento-desc',
            linkSelector: '.bento-cta',
          },
        ],
      });

      const normalized = normalizeSiteContainerProbeDecision(parsed);
      expect(normalized.rules).toHaveLength(1);
      expect(normalized.rules[0].containerSelector).toBe('div.bento-tile');
    });

    it('validates calloutType and trims slot selectors cleanly', () => {
      const rule = containerMappingRuleSchema.parse({
        containerSelector: ' [data-callout-box] ',
        role: 'callout',
        calloutType: 'warning',
        titleSelector: ' .title ',
        bodySelector: ' .body ',
      });
      const normalized = normalizeSiteContainerProbeDecision({ rules: [rule] });
      expect(normalized.rules).toHaveLength(1);
      expect(normalized.rules[0]).toMatchObject({
        containerSelector: '[data-callout-box]',
        role: 'callout',
        calloutType: 'warning',
        titleSelector: '.title',
        bodySelector: '.body',
      });
    });

    it('registers webdoc_container_probe preset with required template placeholders', () => {
      const preset = ALL_PROMPT_PRESETS.find((p) => p.key === 'webdoc_container_probe');
      expect(preset).toBeDefined();
      expect(preset?.module).toBe('webdoc');
      expect(preset?.promptSchema.taskDescription).toContain('{{entryUrl}}');
      expect(preset?.promptSchema.taskDescription).toContain('{{degradedCount}}');
      expect(preset?.promptSchema.taskDescription).toContain('{{skeletonsText}}');
    });
  });
});

