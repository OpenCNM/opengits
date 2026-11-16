import { describe, expect, it, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { setLocale } from '@/paraglide/runtime.js';
import { resolveRepoIngestProgress } from '@/lib/import-wizard/repo-ingest-progress';

let mockStoreState: any = {
  importMode: 'github',
  customOutline: [],
  logs: [],
  ingestSuccessInfo: null,
};

vi.mock('@/lib/stores/import-wizard-store', () => ({
  useImportWizardStore: (selector: (s: any) => any) => selector(mockStoreState),
}));

import { WorkbenchStep3Executing } from '@/components/ImportWizard/workbench/WorkbenchStep3Executing';

describe('resolveRepoIngestProgress - 零物化单调纯函数', () => {
  it('returns initial 10% progress on empty logs', () => {
    const res = resolveRepoIngestProgress([], false);
    expect(res).toEqual({ percent: 10, stageKey: 'init' });
  });

  it('projects [1/5] sha resolution stage', () => {
    const logs = ['[1/5] 解析代码仓版本与提交标识 (Resolve Git SHA)...'];
    const res = resolveRepoIngestProgress(logs, false);
    expect(res.stageKey).toBe('sha');
    expect(res.percent).toBe(18);
  });

  it('projects [2/5] archive download stage with speed metadata', () => {
    const logs = [
      '[1/5] 解析代码仓版本与提交标识 (Resolve Git SHA)...',
      '[2/5] 装载并解压代码仓归档 (Ensure Archive)...',
      '[2/5] 装载归档: 1.1 MB/s (100.0%) · libs/sdk-py/langgraph_sdk/auth/__init__.py',
    ];
    const res = resolveRepoIngestProgress(logs, false);
    expect(res.stageKey).toBe('archive');
    expect(res.percent).toBe(35);
    expect(res.downloadMeta).toBe('1.1 MB/s · 100.0%');
  });

  it('projects [3/5] scan stage', () => {
    const logs = [
      '[1/5] 解析代码仓版本与提交标识 (Resolve Git SHA)...',
      '[2/5] 装载并解压代码仓归档 (Ensure Archive)...',
      '[3/5] 流式扫描文件树与结构嗅探 (Scan Tree & Sniff Profile)...',
    ];
    const res = resolveRepoIngestProgress(logs, false);
    expect(res.stageKey).toBe('scan');
    expect(res.percent).toBe(60);
  });

  it('projects [4/5] outline and AST binding stage', () => {
    const logs = [
      '[1/5] 解析代码仓版本与提交标识 (Resolve Git SHA)...',
      '[2/5] 装载并解压代码仓归档 (Ensure Archive)...',
      '[3/5] 流式扫描文件树与结构嗅探 (Scan Tree & Sniff Profile)...',
      '[4/5] 申请计算内存加权配额 (权重: 1)...',
      '[4/5] 构建大纲导航树与章节落库 (Build NavTree & Create Docs)...',
    ];
    const res = resolveRepoIngestProgress(logs, false);
    expect(res.stageKey).toBe('outline');
    expect(res.percent).toBe(80);
  });

  it('projects [5/5] persistence stage', () => {
    const logs = [
      '[4/5] 构建大纲导航树与章节落库 (Build NavTree & Create Docs)...',
      '[5/5] 单一持久化尾段落库 (Commit & Settle)...',
    ];
    const res = resolveRepoIngestProgress(logs, false);
    expect(res.stageKey).toBe('persist');
    expect(res.percent).toBe(95);
  });

  it('projects 100% completion when ingestSuccess is true or done keyword present', () => {
    const res1 = resolveRepoIngestProgress(['[5/5] 单一持久化尾段落库 (Commit & Settle)...'], true);
    expect(res1).toEqual({ percent: 100, stageKey: 'done' });

    const res2 = resolveRepoIngestProgress(['✓ 导入完成'], false);
    expect(res2.percent).toBe(100);
    expect(res2.stageKey).toBe('done');
  });
});

describe('WorkbenchStep3Executing - GitHub Repo 进度条模式渲染', () => {
  beforeEach(() => {
    setLocale('zh-CN');
    mockStoreState = {
      importMode: 'github',
      customOutline: [],
      logs: [],
      ingestSuccessInfo: null,
    };
  });

  it('renders progress bar and stage copy during repository import without custom outline', () => {
    mockStoreState = {
      importMode: 'github',
      customOutline: [],
      logs: [
        '02:06:50 [1/5] 解析代码仓版本与提交标识 (Resolve Git SHA)...',
        '02:06:50 [2/5] 装载并解压代码仓归档 (Ensure Archive)...',
        '02:06:50 识别为知名经典开源项目（高星标开源项目 (Stars: 44k+)），配额放宽至 250MB',
        '02:06:50 [2/5] 装载归档: 1.1 MB/s (100.0%) · libs/sdk-py/langgraph_sdk/auth/__init__.py',
        '02:06:50 [3/5] 流式扫描文件树与结构嗅探 (Scan Tree & Sniff Profile)...',
        '02:06:50 [4/5] 申请计算内存加权配额 (权重: 1)...',
        '02:06:50 [4/5] 构建大纲导航树与章节落库 (Build NavTree & Create Docs)...',
      ],
      ingestSuccessInfo: null,
    };

    const html = renderToString(
      React.createElement(WorkbenchStep3Executing, {
        onGoToTutorial: () => {},
        onGoToShelf: () => {},
      })
    );

    // 验证包含进度百分比与友好语义阶段文案
    expect(html).toContain('80%');
    expect(html).toContain('正在构建知识大纲与 AST 符号绑定…');
    expect(html).toContain('1.1 MB/s · 100.0%');
    // 验证保留可折叠日志抽屉（Chesterton Fence）
    expect(html).toContain('处理日志');
    expect(html).toContain('展开处理日志');
  });

  it('renders stable progress view and latched outline summary when custom outline is present', () => {
    mockStoreState = {
      importMode: 'github',
      customOutline: [
        {
          name: 'Chapter 1: Getting Started',
          files: [{ path: 'src/index.ts', shortTitle: 'Entry' }],
        },
      ],
      logs: [
        '[1/5] 解析代码仓版本与提交标识 (Resolve Git SHA)...',
        '[2/5] 装载并解压代码仓归档 (Ensure Archive)...',
      ],
      ingestSuccessInfo: null,
    };

    const html = renderToString(
      React.createElement(WorkbenchStep3Executing, {
        onGoToTutorial: () => {},
        onGoToShelf: () => {},
      })
    );

    // 验证第一帧即由进度条主面板驱动（35% + 正在装载），杜绝大纲列表 DOM 闪现
    expect(html).toContain('35%');
    expect(html).toContain('正在装载并解压仓库代码归档…');
    // 验证顶部横幅锁存并展示规划章节统计，不受后续 handoffToIngest 清空草稿影响
    expect(html).toContain('共 1 个章节 · 1 节课时');
    // 验证无任何多余章节卡片列表渲染
    expect(html).not.toContain('Chapter 1: Getting Started');
  });
});
