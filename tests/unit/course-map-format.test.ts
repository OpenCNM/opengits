import { test, expect, describe } from 'vitest';
import { formatCourseMap } from '@/lib/mcp/course-map';
import {
  extractKeywords,
  formatCrossRepoConceptSearch,
  formatRecommendTutorial,
  formatSkillCoverage,
  CrossRepoConceptHit,
  RepoCoverageScore,
  SkillCoverageHit,
} from '@/lib/mcp/cross-repo-tools';
import type { NavNode } from '@/engine/structurizer';

describe('course-map 与 cross-repo 纯函数格式化', () => {
  describe('formatCourseMap 课程图视图渲染', () => {
    test('代码仓有 codeClusters：渲染 Mermaid 依赖图与章节清单', () => {
      const repoProfile = {
        codeClusters: [
          { teachingOrder: 1, title: '起步与环境', files: ['src/index.ts', 'src/env.ts'] },
          { teachingOrder: 2, title: '核心调度 "Engine"', files: ['src/core.ts'] },
        ],
      };

      const text = formatCourseMap(repoProfile);
      expect(text).toContain('🗺️ Course Map — 2 章 / 3 文件（按教学顺序）');
      expect(text).toContain('```mermaid\nflowchart TD');
      expect(text).toContain('Ch01["1. 起步与环境（2 文件）"]');
      expect(text).toContain('Ch01 --> Ch02');
      expect(text).toContain('Ch02["2. 核心调度 \'\'Engine\'\'（1 文件）"]'); // 引号已转义
      expect(text).toContain('章节清单');
      expect(text).toContain('- 1. 起步与环境 — 2 文件');
    });

    test('代码仓带 cognitive 元数据：渲染 4 阶认知分层子图与真实 DAG 依赖边', () => {
      const repoProfile = {
        codeClusters: [
          {
            teachingOrder: 1,
            title: '基础核心',
            directories: ['src/core'],
            files: ['src/core/base.ts'],
            cognitive: {
              phase: 'phase1_perception',
              upstreamModules: [],
            },
          },
          {
            teachingOrder: 2,
            title: '流水线调度',
            directories: ['src/pipeline'],
            files: ['src/pipeline/runner.ts'],
            cognitive: {
              phase: 'phase3_pipeline',
              upstreamModules: ['src/core'],
            },
          },
        ],
      };

      const text = formatCourseMap(repoProfile);
      expect(text).toContain('🗺️ Course Map — 2 章 / 2 文件（按教学顺序）');
      expect(text).toContain('```mermaid\nflowchart TD');
      expect(text).toContain('subgraph Phase_Foundation["🌱 基础层 (Foundation)"]');
      expect(text).toContain('Ch01["1. 基础核心（1 文件）"]');
      expect(text).toContain('subgraph Phase_Interface["🔌 接口层 (Interface & Delivery)"]');
      expect(text).toContain('Ch02["2. 流水线调度（1 文件）"]');
      expect(text).toContain('Ch01 --> Ch02');
    });

    test('非代码仓无 codeClusters：退化为 navTree 文件大纲', () => {
      const navTree: NavNode[] = [
        {
          name: 'intro',
          title: '入门指南',
          type: 'file',
          path: 'docs/intro.md',
          url: '/docs/o/r/intro',
        },
        {
          name: 'advanced',
          title: '进阶主题',
          type: 'file',
          path: 'docs/advanced.md',
          url: '/docs/o/r/advanced',
        },
      ];

      const text = formatCourseMap({}, navTree);
      expect(text).toContain('🗺️ Course Map（文档大纲兜底，2 篇）');
      expect(text).toContain('1. 入门指南 [Path: docs/intro.md]');
      expect(text).toContain('2. 进阶主题 [Path: docs/advanced.md]');
    });

    test('空仓库无 codeClusters 且 navTree 为空', () => {
      const text = formatCourseMap({}, []);
      expect(text).toContain('无法生成课程图。可用 outline 查看文档清单');
    });
  });

  describe('extractKeywords 关键词提取', () => {
    test('去停用词、去重、过滤单字符与标点分词', () => {
      const desc = '我要用 Next.js 和 Rust 搭建一个 Web 应用，with async/await';
      const keywords = extractKeywords(desc);
      expect(keywords).toContain('next');
      expect(keywords).toContain('js');
      expect(keywords).toContain('rust');
      expect(keywords).toContain('web');
      expect(keywords).toContain('async');
      expect(keywords).toContain('await');
      expect(keywords).not.toContain('我');
      expect(keywords).not.toContain('要');
      expect(keywords).not.toContain('with');
    });
  });

  describe('formatCrossRepoConceptSearch 跨仓概念检索渲染', () => {
    test('已对齐全局概念跨仓归并与单仓概念分组展示', () => {
      const hits: CrossRepoConceptHit[] = [
        {
          conceptId: 'c1',
          conceptName: '响应式数据绑定',
          category: 'architecture',
          globalConceptId: 'gc-reactivity',
          repoId: 'r1',
          repoOwner: 'vuejs',
          repoName: 'core',
          docPath: 'docs/reactivity.md',
          address: 'docs/reactivity.md#reactivity',
        },
        {
          conceptId: 'c2',
          conceptName: 'Signals 响应式',
          category: 'architecture',
          globalConceptId: 'gc-reactivity',
          repoId: 'r2',
          repoOwner: 'solidjs',
          repoName: 'solid',
          docPath: 'docs/signals.md',
          address: 'docs/signals.md#signals',
        },
        {
          conceptId: 'c3',
          conceptName: '独有架构设计',
          category: 'workflow',
          globalConceptId: null,
          repoId: 'r1',
          repoOwner: 'vuejs',
          repoName: 'core',
          docPath: 'docs/arch.md',
          address: null,
        },
      ];

      const globalConceptsById = new Map([
        ['gc-reactivity', { canonicalName: '响应式系统', aliases: ['Reactivity', 'Signals'] }],
      ]);

      const text = formatCrossRepoConceptSearch('响应式', hits, globalConceptsById);
      expect(text).toContain('3 命中 / 1 全局概念 / 1 单仓');
      expect(text).toContain('**响应式系统**（别名: Reactivity、Signals） — 覆盖 2 仓:');
      expect(text).toContain('vuejs/core: 响应式数据绑定 [Address: docs/reactivity.md#reactivity]');
      expect(text).toContain('solidjs/solid: Signals 响应式 [Address: docs/signals.md#signals]');
      expect(text).toContain('单仓概念（未跨仓归并');
      expect(text).toContain('vuejs/core: 独有架构设计 (workflow)');
    });

    test('无命中时输出友好提示', () => {
      const text = formatCrossRepoConceptSearch('未知概念', [], new Map());
      expect(text).toContain('书架内无匹配概念');
    });
  });

  describe('formatRecommendTutorial 与 formatSkillCoverage', () => {
    test('formatRecommendTutorial 排序与命中展示', () => {
      const ranked: RepoCoverageScore[] = [
        {
          repo: { id: 'r1', owner: 'facebook', repo: 'react' },
          totalConcepts: 10,
          matchedConcepts: [
            { conceptName: 'Fiber 架构', category: 'architecture', docPath: 'fiber.md', address: 'fiber.md#fiber' },
          ],
          score: 0.8,
        },
      ];

      const text = formatRecommendTutorial('React 核心', ranked);
      expect(text).toContain('facebook/react（覆盖分 80%，命中 1/10 概念）');
      expect(text).toContain('Fiber 架构 (architecture) [Address: fiber.md#fiber]');
    });

    test('formatSkillCoverage 深度标签（入门级 vs 前置数）', () => {
      const hits: SkillCoverageHit[] = [
        {
          repo: { id: 'r1', owner: 'org1', repo: 'basic-repo' },
          conceptName: '基础概念',
          category: 'principle',
          address: 'basic.md#1',
          prereqCount: 0,
          globalConceptId: null,
        },
        {
          repo: { id: 'r2', owner: 'org2', repo: 'deep-repo' },
          conceptName: '高级抽象',
          category: 'architecture',
          address: 'deep.md#2',
          prereqCount: 5,
          globalConceptId: null,
        },
      ];

      const text = formatSkillCoverage('系统设计', hits);
      expect(text).toContain('深度: 入门级（无前置）');
      expect(text).toContain('深度: 5 个前置概念');
    });
  });
});
