import { describe, it, expect } from 'vitest';
import { fallbackWarning, RepoContext } from '@/lib/mcp/tools/shared';
import { runOutline } from '@/lib/mcp/tools/outline';

const baseCtx = (over: Partial<RepoContext> = {}): RepoContext => ({
  owner: 'acme',
  repo: 'calculator',
  repository: {
    id: 'repo-1',
    owner: 'acme',
    repo: 'calculator',
    branch: 'main',
    repoProfile: {},
    navTree: [],
    documents: [],
  },
  ...over,
});

describe('讲法/版本回退 fail-loud 警告', () => {
  it('isFallback=true 时输出请求与实际服务的讲法', () => {
    const text = fallbackWarning(baseCtx({ isFallback: true, requestedEdition: 'ed_deep', edition: '', editionLabel: undefined }));
    expect(text).toContain('⚠ Edition fallback: requested "ed_deep" was not found');
    expect(text).toContain('results below come from the BASE edition');
    expect(text).toContain('Use list_resources to discover available editions');
  });

  it('回退到讲法行时标注讲法显示名', () => {
    const text = fallbackWarning(baseCtx({ isFallback: true, requestedEdition: 'v16', edition: 'ed_deep', editionLabel: '深度剖析版' }));
    expect(text).toContain('results below come from edition "深度剖析版"');
  });

  it('非回退上下文返回空串（零输出噪音）', () => {
    expect(fallbackWarning(baseCtx())).toBe('');
    expect(fallbackWarning(baseCtx({ isFallback: false, requestedEdition: 'ed_deep' }))).toBe('');
  });

  it('端到端：outline 在回退上下文下头部注入警告行', async () => {
    const runtime = {
      multiRepo: false,
      resolveRepository: async () => baseCtx({ isFallback: true, requestedEdition: 'ed_deep' }),
    } as any;
    const res = await runOutline({}, runtime);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('⚠ Edition fallback: requested "ed_deep" was not found');
    expect(text).toContain('Available Documentation in acme/calculator');
  });
});
