import { describe, expect, it, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { setLocale } from '@/paraglide/runtime.js';

let mockStoreState: any = {
  importMode: 'web',
  customOutline: [],
  logs: [],
  ingestSuccessInfo: null,
};

vi.mock('@/lib/stores/import-wizard-store', () => ({
  useImportWizardStore: (selector: (s: any) => any) => selector(mockStoreState),
}));

import { WorkbenchStep3Executing } from '@/components/ImportWizard/workbench/WorkbenchStep3Executing';

describe('WorkbenchStep3Executing - Web Doc Import Feedback', () => {
  beforeEach(() => {
    setLocale('zh-CN');
    mockStoreState = {
      importMode: 'web',
      customOutline: [],
      logs: [],
      ingestSuccessInfo: null,
    };
  });

  it('renders web doc specific waiting title and preparing hint when logs are empty', () => {
    mockStoreState = {
      importMode: 'web',
      customOutline: [],
      logs: [],
      ingestSuccessInfo: null,
    };

    const html = renderToString(
      React.createElement(WorkbenchStep3Executing, {
        onGoToTutorial: () => {},
        onGoToShelf: () => {},
      })
    );

    expect(html).toContain('正在抓取与解析网页文档...');
    expect(html).toContain('正在抓取站点页面、清洗正文并构建知识大纲索引。');
    expect(html).toContain('处理日志');
    expect(html).toContain('正在准备入库...');
    // WebDoc 已移除冗余「全量解析模式」徽章
    expect(html).not.toContain('全量解析模式');
    expect(html).not.toContain('文档解析与图谱');
  });

  it('renders real-time streaming logs and updates latestLog dynamically', () => {
    mockStoreState = {
      importMode: 'web',
      customOutline: [],
      logs: [
        '[1/3] 解析文档站点目标地址: https://eve.dev...',
        '[1/3] 识别静态入口: 《Eve Documentation》，发现 28 个文档链接',
        '[2/3] 正在抓取: Getting Started (5/28)...',
      ],
      ingestSuccessInfo: null,
    };

    const html = renderToString(
      React.createElement(WorkbenchStep3Executing, {
        onGoToTutorial: () => {},
        onGoToShelf: () => {},
      })
    );

    expect(html).toContain('3'); // logs.length
    expect(html).toContain('[1/3] 解析文档站点目标地址: https://eve.dev...');
    expect(html).toContain('[1/3] 识别静态入口: 《Eve Documentation》，发现 28 个文档链接');
    expect(html).toContain('[2/3] 正在抓取: Getting Started (5/28)...');
    // 单列化后最新进度由日志 header 承载(原右栏 ⚡ 卡片已删,零重复)
    expect(html).toContain('·');
    expect(html).toContain('Getting Started (5/28)...');
  });

  it('renders minimal ready focus card without transcription milestones for completed web doc import', () => {
    mockStoreState = {
      importMode: 'web',
      customOutline: [],
      logs: ['✓ 文档站点全部解析入库完成 (共 28 篇文档已就绪)'],
      ingestSuccessInfo: {
        owner: 'web-docs',
        repo: 'eve-dev',
      },
    };

    const html = renderToString(
      React.createElement(WorkbenchStep3Executing, {
        onGoToTutorial: () => {},
        onGoToShelf: () => {},
      })
    );

    expect(html).toContain('网页文档镜像已就绪，全站页面可直接阅读');
    expect(html).toContain('已完成全站页面抓取、正文解析与目录索引构建。');
    expect(html).toContain('立即开始阅读');
    expect(html).toContain('展开处理日志');
    expect(html).not.toContain('转录');
    expect(html).not.toContain('代码分析与下载');
    expect(html).not.toContain('知识大纲构建');
  });

  it('preserves 3-stage milestone card for completed github repository import', () => {
    mockStoreState = {
      importMode: 'github',
      customOutline: [],
      logs: ['Ingestion pipeline completed successfully.'],
      ingestSuccessInfo: {
        owner: 'vercel',
        repo: 'ai',
      },
    };

    const html = renderToString(
      React.createElement(WorkbenchStep3Executing, {
        onGoToTutorial: () => {},
        onGoToShelf: () => {},
      })
    );

    expect(html).toContain('知识架构就绪，AI 转录已启动');
    expect(html).toContain('代码分析与下载');
    expect(html).toContain('知识大纲构建');
    expect(html).toContain('章节详情转录');
    expect(html).toContain('立即进入详情 · 开启实时阅读');
  });
});
