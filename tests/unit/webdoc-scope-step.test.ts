import { describe, expect, it, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { setLocale } from '@/paraglide/runtime.js';

const mockContext = {
  url: 'https://eve.dev/docs/getting-started',
  setSubStep: vi.fn(),
  submitWebDocImport: vi.fn(async () => {}),
  isPublic: true,
  setIsPublic: vi.fn(),
};

vi.mock('@/components/ImportWizard/ImportWizardContext', () => ({
  useImportWizard: () => mockContext,
}));

import {
  WebDocScopeStep,
  startWebDocScout,
  type ScoutState,
} from '@/components/ImportWizard/webdoc/WebDocScopeStep';
import { WebDocStepBar } from '@/components/ImportWizard/common/WebDocStepBar';
import {
  resolveWebDocCrawlProgress,
  resolveWebDocJourneyStage,
} from '@/lib/import-wizard/webdoc-scope';
import { buildImportedTutorialHref } from '@/lib/import-wizard/navigation';

describe('WebDocScopeStep - 极简目录勾选与去杂项验证', () => {
  beforeEach(() => {
    setLocale('zh-CN');
    vi.clearAllMocks();
    mockContext.url = 'https://eve.dev/docs/getting-started';
    mockContext.isPublic = true;
  });

  it('renders clean hostname, scouting indicator, and disabled CTA scaffold while probing', () => {
    const html = renderToString(React.createElement(WebDocScopeStep));

    expect(html).toContain('eve.dev/docs/getting-started');
    expect(html).toContain('更换链接');
    expect(html).toContain('正在嗅探 eve.dev 的站点目录…');
    // 中间面板与底部 CTA 按钮均须展示 spinning loading
    expect(html.match(/animate-spin/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('正在解析站点…');
    expect(html).toContain('disabled');
    expect(html).not.toContain('重新嗅探');
    // 彻底剥除 GitHub 专属公共开关与杂项
    expect(html).not.toContain('导入为公共教程');
    expect(html).not.toContain('公开奖励');
    expect(html).not.toContain('开始全量抓取并导入');
  });

  it('never fabricates directory checklist content before scout settles', () => {
    const html = renderToString(React.createElement(WebDocScopeStep));

    expect(html).not.toContain('改抓整站');
    expect(html).not.toContain('开始整站抓取');
    expect(html).not.toContain('选择要抓取的目录');
    expect(html).not.toContain('含章节');
  });

  it('keeps rendering for bare hostnames without a path', () => {
    mockContext.url = 'https://docs.example.org';
    const html = renderToString(React.createElement(WebDocScopeStep));
    expect(html).toContain('docs.example.org');
    expect(html).toContain('正在嗅探 docs.example.org 的站点目录…');
  });

  it('renders minimal multi_module directory checklist without tabs, duplicate cards, or public toggle', () => {
    mockContext.url = 'https://coss.com/ui/docs';
    const html = renderToString(
      React.createElement(WebDocScopeStep, {
        initialScoutOverride: {
          status: 'ready',
          scoutStatus: 'multi_module',
          primaryDocPrefix: '/ui/docs',
          moduleTabs: [
            { id: 'docs', label: 'Docs', path: '/ui/docs', kind: 'doc' },
            { id: 'particles', label: 'Particles', path: '/ui/particles', kind: 'doc' },
            { id: 'chat', label: 'Chat UI', path: '/ui/chat', kind: 'doc' },
            { id: 'changelog', label: 'Changelog', path: '/ui/changelog', kind: 'changelog' },
          ],
          sidebarHeadings: ['Introduction', 'Get Started', 'Accordion'],
        },
      }),
    );

    expect(html).toContain('coss.com/ui/docs');
    expect(html).toContain('重新嗅探');
    expect(html).toContain('选择要抓取的目录');
    expect(html).toContain('全选');
    expect(html).toContain('改抓整站');
    expect(html).toContain('Docs');
    expect(html).toContain('/ui/docs');
    expect(html).toContain('Particles');
    expect(html).toContain('/ui/particles');
    expect(html).toContain('Chat UI');
    expect(html).toContain('/ui/chat');
    expect(html).toContain('默认');
    expect(html).toContain('默认跳过');
    expect(html).toContain('Get Started · Accordion');
    expect(html).toContain('开始抓取（已选 1 个目录）');

    // 确认页去杂项不变量
    expect(html).not.toContain('导入为公共教程');
    expect(html).not.toContain('按目录勾选');
    expect(html).not.toContain('第 3 步 · 确认抓取目录');
    expect(html).not.toContain('推荐 · 默认勾选');
    expect(html).not.toContain('（0 个）');
    expect(html).not.toContain('已选 0 个模块');
  });

  it('renders single_module state cleanly without ever displaying 0 modules', () => {
    mockContext.url = 'https://coss.com/ui/docs';
    const html = renderToString(
      React.createElement(WebDocScopeStep, {
        initialScoutOverride: {
          status: 'ready',
          scoutStatus: 'single_module',
          primaryDocPrefix: '/ui/docs',
          moduleTabs: [{ id: 'docs', label: 'Docs', path: '/ui/docs', kind: 'doc' }],
          sidebarHeadings: ['Introduction', 'Styling'],
        },
      }),
    );

    expect(html).toContain('/ui/docs');
    expect(html).toContain('Styling');
    expect(html).toContain('开始抓取');
    expect(html).toContain('改抓整站');
    expect(html).not.toContain('未识别到站点模块');
    expect(html).not.toContain('导入为公共教程');
    expect(html).not.toContain('（0 个）');
  });

  it('renders honest scan_failed state with retry button, differentiated reason, and full-crawl fallback CTA', () => {
    mockContext.url = 'https://coss.com/ui/docs';
    const timeoutHtml = renderToString(
      React.createElement(WebDocScopeStep, {
        initialScoutOverride: {
          status: 'scan_failed',
          reason: 'timeout',
        },
      }),
    );

    expect(timeoutHtml).toContain('目标站点响应较慢或暂无法预览目录结构');
    expect(timeoutHtml).toContain('重试探测');
    expect(timeoutHtml).not.toContain('重新嗅探');
    expect(timeoutHtml).toContain('开始全量抓取并导入');
    expect(timeoutHtml).not.toContain('导入为公共教程');
    expect(timeoutHtml).not.toContain('（0 个）');

    const sidecarHtml = renderToString(
      React.createElement(WebDocScopeStep, {
        initialScoutOverride: {
          status: 'scan_failed',
          reason: 'webdoc-topology-scout: sidecar unreachable (fetch failed)',
        },
      }),
    );
    expect(sidecarHtml).toContain('目录探测服务暂不可用');

    const rateLimitedHtml = renderToString(
      React.createElement(WebDocScopeStep, {
        initialScoutOverride: {
          status: 'scan_failed',
          reason: 'HTTP 429',
        },
      }),
    );
    expect(rateLimitedHtml).toContain('探测请求过于频繁');
  });

  it('builds tutorial destination href cleanly for web-docs and github editions', () => {
    expect(
      buildImportedTutorialHref({ owner: 'web-docs', repo: 'coss-com' }),
    ).toBe('/docs/web-docs/coss-com');

    expect(
      buildImportedTutorialHref({
        owner: 'vercel',
        repo: 'ai',
        landingPath: '01-getting-started.mdx',
        edition: 'deep-dive',
      }),
    ).toBe('/docs/vercel/ai/01-getting-started?edition=deep-dive');
  });
});

describe('WebDocStepBar & resolveWebDocJourneyStage - 横向引导步骤映射', () => {
  beforeEach(() => {
    setLocale('zh-CN');
  });

  it('resolves all 5 webdoc journey stages cleanly from wizard states', () => {
    expect(
      resolveWebDocJourneyStage({ step: 1, subStep: 'input', webScoutPhase: 'idle', ingestSuccess: false }),
    ).toBe('input');
    expect(
      resolveWebDocJourneyStage({ step: 1, subStep: 'web_confirm', webScoutPhase: 'scouting', ingestSuccess: false }),
    ).toBe('scout');
    expect(
      resolveWebDocJourneyStage({ step: 1, subStep: 'web_confirm', webScoutPhase: 'ready', ingestSuccess: false }),
    ).toBe('confirm');
    // 嗅探失败时停留在步骤 2「嗅探站点」而非假勾推进至确认目录
    expect(
      resolveWebDocJourneyStage({ step: 1, subStep: 'web_confirm', webScoutPhase: 'failed', ingestSuccess: false }),
    ).toBe('scout');
    expect(
      resolveWebDocJourneyStage({ step: 3, subStep: 'web_confirm', webScoutPhase: 'ready', ingestSuccess: false }),
    ).toBe('crawl');
    expect(
      resolveWebDocJourneyStage({ step: 3, subStep: 'web_confirm', webScoutPhase: 'ready', ingestSuccess: true }),
    ).toBe('done');
  });

  it('renders scoutFailed step bar in warning state without spinning loader', () => {
    const failedStepHtml = renderToString(
      React.createElement(WebDocStepBar, {
        activeStage: 'scout',
        scoutFailed: true,
        onBackToInput: () => {},
      }),
    );
    expect(failedStepHtml).toContain('aria-current="step"');
    expect(failedStepHtml).not.toContain('animate-spin');
  });

  it('renders horizontal 5-step bar across zh-CN / en and marks active step', () => {
    const confirmHtml = renderToString(
      React.createElement(WebDocStepBar, {
        activeStage: 'confirm',
        onBackToInput: () => {},
      }),
    );

    expect(confirmHtml).toContain('输入链接');
    expect(confirmHtml).toContain('嗅探站点');
    expect(confirmHtml).toContain('确认目录');
    expect(confirmHtml).toContain('开始抓取');
    expect(confirmHtml).toContain('完成导入');
    expect(confirmHtml).toContain('aria-current="step"');
    // Step 1 renders as clickable button when returning from confirm stage
    expect(confirmHtml).toContain('<button type="button"');

    setLocale('en');
    const enDoneHtml = renderToString(
      React.createElement(WebDocStepBar, {
        activeStage: 'done',
      }),
    );
    expect(enDoneHtml).toContain('URL');
    expect(enDoneHtml).toContain('Scout');
    expect(enDoneHtml).toContain('Directories');
    expect(enDoneHtml).toContain('Crawl');
    expect(enDoneHtml).toContain('Ready');
    // 结束后已过去步骤为灰色，仅当前完成步骤（Ready）高亮并带 aria-current="step"
    expect(enDoneHtml.match(/bg-emerald-500\/10/g)).toHaveLength(1);
    expect(enDoneHtml.match(/aria-current="step"/g)).toHaveLength(1);
  });

  it('projects webdoc crawl logs monotonically without exposing counts', () => {
    expect(resolveWebDocCrawlProgress([], false)).toEqual({ percent: 12, stageKey: 'connecting' });
    expect(resolveWebDocCrawlProgress(['[1/3] 识别静态入口: 《Intro》，发现 73 个文档链接'], false)).toEqual({
      percent: 24,
      stageKey: 'entry',
    });
    expect(
      resolveWebDocCrawlProgress([
        '[1/3] 解析文档站点目标地址...',
        '[2/3] 正在抓取: Skills (5/68)...',
        '[2/3] 正在抓取: useMediaQuery (65/69)...',
      ], false),
    ).toEqual({ percent: 34, stageKey: 'fetching' });
    expect(
      resolveWebDocCrawlProgress(['[2/3] 抓取网页文档内容完成 (fast-path 引擎，共 67 页)'], false),
    ).toEqual({ percent: 64, stageKey: 'assets' });
    expect(
      resolveWebDocCrawlProgress(['[3/3] 构建文档大纲导航树与知识目录...'], false),
    ).toEqual({ percent: 82, stageKey: 'tree' });
    expect(resolveWebDocCrawlProgress(['any'], true)).toEqual({ percent: 100, stageKey: 'done' });
  });
});

function createDeferredFetch() {
  const calls: Array<{
    init?: RequestInit;
    resolve: (res: Response) => void;
    reject: (err: unknown) => void;
  }> = [];

  const fetchMock: typeof fetch = (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      const entry = { init, resolve, reject };
      calls.push(entry);
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    });

  return { fetchMock, calls };
}

describe('startWebDocScout - StrictMode 清理与真实超时隔离', () => {
  it('keeps loading state across React StrictMode cleanup/remount while second fetch is pending', async () => {
    const states: ScoutState[] = [];
    const { fetchMock, calls } = createDeferredFetch();

    // Mount 1 -> StrictMode immediate cleanup -> Mount 2
    const cleanup1 = startWebDocScout({
      url: 'https://coss.com/ui/docs',
      bypassCache: false,
      fetchImpl: fetchMock,
      onState: (s) => states.push(s),
    });
    cleanup1();

    const cleanup2 = startWebDocScout({
      url: 'https://coss.com/ui/docs',
      bypassCache: false,
      fetchImpl: fetchMock,
      onState: (s) => states.push(s),
    });

    // 等待微任务让 fetch1 的 AbortError catch 跑完
    await Promise.resolve();
    await Promise.resolve();

    // 关键不变式：fetch2 仍在探测中时，状态必须严格保持 loading，绝不能被 cleanup1 覆写为 scan_failed
    expect(states).toEqual([{ status: 'loading' }, { status: 'loading' }]);
    expect(calls).toHaveLength(2);

    // fetch2 完成后正常进入 ready
    calls[1].resolve(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            available: true,
            scoutStatus: 'multi_module',
            primaryDocPrefix: '/ui/docs',
            moduleTabs: [
              { id: 'docs', label: 'Docs', path: '/ui/docs', kind: 'doc' },
              { id: 'particles', label: 'Particles', path: '/ui/particles', kind: 'doc' },
            ],
            sidebarHeadings: ['Introduction'],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(states[states.length - 1]).toEqual({
      status: 'ready',
      scoutStatus: 'multi_module',
      primaryDocPrefix: '/ui/docs',
      moduleTabs: [
        { id: 'docs', label: 'Docs', path: '/ui/docs', kind: 'doc' },
        { id: 'particles', label: 'Particles', path: '/ui/particles', kind: 'doc' },
      ],
      sidebarHeadings: ['Introduction'],
    });
    cleanup2();
  });

  it('ignores aborted previous attempt on retry and keeps loading with bypassCache=true', async () => {
    const states: ScoutState[] = [];
    const { fetchMock, calls } = createDeferredFetch();

    const cleanupFirst = startWebDocScout({
      url: 'https://coss.com/ui/docs',
      bypassCache: false,
      fetchImpl: fetchMock,
      onState: (s) => states.push(s),
    });
    cleanupFirst();

    const cleanupRetry = startWebDocScout({
      url: 'https://coss.com/ui/docs',
      bypassCache: true,
      fetchImpl: fetchMock,
      onState: (s) => states.push(s),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(states).toEqual([{ status: 'loading' }, { status: 'loading' }]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      url: 'https://coss.com/ui/docs',
      bypassCache: true,
    });
    cleanupRetry();
  });

  it('transitions to scan_failed(timeout) only when real timeout fires without cleanup', async () => {
    vi.useFakeTimers();
    try {
      const states: ScoutState[] = [];
      const { fetchMock } = createDeferredFetch();

      const cleanup = startWebDocScout({
        url: 'https://coss.com/ui/docs',
        bypassCache: false,
        timeoutMs: 100,
        fetchImpl: fetchMock,
        onState: (s) => states.push(s),
      });

      expect(states).toEqual([{ status: 'loading' }]);
      await vi.advanceTimersByTimeAsync(120);

      expect(states).toEqual([
        { status: 'loading' },
        { status: 'scan_failed', reason: 'timeout' },
      ]);
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it('transitions to scan_failed when server returns scoutStatus=scan_failed', async () => {
    const states: ScoutState[] = [];
    const { fetchMock, calls } = createDeferredFetch();

    const cleanup = startWebDocScout({
      url: 'https://coss.com/ui/docs',
      bypassCache: false,
      fetchImpl: fetchMock,
      onState: (s) => states.push(s),
    });

    calls[0].resolve(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            available: false,
            scoutStatus: 'scan_failed',
            reason: 'upstream 403',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(states).toEqual([
      { status: 'loading' },
      { status: 'scan_failed', reason: 'upstream 403' },
    ]);
    cleanup();
  });
});
