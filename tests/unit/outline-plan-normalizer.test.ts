import { describe, expect, it } from 'vitest';
import { normalizeOutlinePlan, normalizeOutlineMap, cleanChapterName } from '@/lib/llm-gateway/normalizers';
import { lookupLlmPurpose } from '@/lib/llm-gateway/registry';

describe('大纲规划确定性收敛漏斗测试 (Outline Plan Deterministic Convergence Funnel Tests)', () => {
  const planPurpose = lookupLlmPurpose('outline_plan_v1')!;

  it('🧪 [TC-FUNNEL-CHAPTER-0-MISSING-MODULE] 第 1 章即缺失 moduleTitle 时，自动按 phase/序号派生模块名，且后续章节自动继承', () => {
    const raw = {
      curriculumMode: 'matrix',
      chapters: [
        {
          name: '第 1 章: 架构全景与环境准备',
          summary: '全景与准备',
          targetPaths: ['README.md'],
          phase: '入门',
        },
        {
          name: '第 2 章: 源码结构与运行入口',
          summary: '源码结构',
          targetPaths: ['src'],
          phase: '入门',
        },
      ],
    };

    const normalized = planPurpose.normalizeOutput!(raw);
    const parsed = planPurpose.schema!.safeParse(normalized);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.chapters[0].moduleTitle).toBe('模块 1: 架构全景与环境准备');
      expect(parsed.data.chapters[1].moduleTitle).toBe('模块 1: 架构全景与环境准备');
    }
  });

  it('🧪 [TC-FUNNEL-SUMMARY-OVERFLOW-AND-MISSING] summary 超长自动截断至 250 字，summary 缺失自动由 name 派生', () => {
    const raw = {
      curriculumMode: 'matrix',
      chapters: [
        {
          moduleTitle: '模块 1: 基础',
          name: '第 1 章: 核心算法',
          summary: 'A'.repeat(300), // 超长 300 字
          targetPaths: ['src/algo'],
          phase: '进阶',
        },
        {
          moduleTitle: '模块 1: 基础',
          name: '第 2 章: 扩展系统',
          // summary 缺失
          targetPaths: ['src/ext'],
          phase: '进阶',
        },
      ],
    };

    const normalized = planPurpose.normalizeOutput!(raw);
    const parsed = planPurpose.schema!.safeParse(normalized);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.chapters[0].summary).toHaveLength(250);
      expect(parsed.data.chapters[1].summary).toContain('第 2 章: 扩展系统');
    }
  });

  it('🧪 [TC-FUNNEL-TARGET-PATHS-RESILIENCE] targetPaths 单字符串自动转数组，空数组兜底 README.md，超 4 个路径确定性裁剪', () => {
    const raw = {
      curriculumMode: 'matrix',
      chapters: [
        {
          moduleTitle: '模块 1: 基础',
          name: '第 1 章: 单字符串路径',
          summary: '测试单字符串',
          targetPaths: 'src/single' as any, // 字符串而非数组
          phase: '入门',
        },
        {
          moduleTitle: '模块 1: 基础',
          name: '第 2 章: 空路径',
          summary: '测试空数组',
          targetPaths: [],
          phase: '入门',
        },
        {
          moduleTitle: '模块 1: 基础',
          name: '第 3 章: 超 4 路径',
          summary: '测试截断',
          targetPaths: ['a', 'b', 'c', 'd', 'e', 'f'],
          phase: '入门',
        },
      ],
    };

    const normalized = planPurpose.normalizeOutput!(raw);
    const parsed = planPurpose.schema!.safeParse(normalized);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.chapters[0].targetPaths).toEqual(['src/single']);
      expect(parsed.data.chapters[1].targetPaths).toEqual(['README.md']);
      expect(parsed.data.chapters[2].targetPaths).toEqual(['a', 'b', 'c', 'd']);
    }
  });

  it('🧪 [TC-FUNNEL-MAX-CHAPTERS-CLAMPING] 模型生成超过 14 章时，确定性截取前 14 章，绝不抛出错误中断', () => {
    const raw = {
      curriculumMode: 'matrix',
      chapters: Array.from({ length: 18 }, (_, i) => ({
        moduleTitle: `模块 ${Math.floor(i / 5) + 1}: 主题`,
        name: `第 ${i + 1} 章: 章节内容`,
        summary: `摘要 ${i + 1}`,
        targetPaths: ['src'],
        phase: '进阶',
      })),
    };

    const normalized = planPurpose.normalizeOutput!(raw);
    const parsed = planPurpose.schema!.safeParse(normalized);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.chapters).toHaveLength(14);
      expect(parsed.data.chapters[13].name).toBe('第 14 章: 章节内容');
    }
  });

  it('🧪 [TC-FUNNEL-ENVELOPE-UNWRAPPING] 模型在外层包裹 data 或 result 时，自动下钻解包', () => {
    const raw = {
      data: {
        curriculumMode: 'Matrix', // 大写 Mode
        chapters: [
          {
            moduleTitle: '模块 1: 全景',
            title: '第 1 章: 入门总览', // title 别名
            desc: '核心职责说明', // desc 别名
            paths: ['src/core'], // paths 别名
          },
        ],
      },
    };

    const normalized = planPurpose.normalizeOutput!(raw);
    const parsed = planPurpose.schema!.safeParse(normalized);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.curriculumMode).toBe('matrix');
      expect(parsed.data.chapters[0].name).toBe('第 1 章: 入门总览');
      expect(parsed.data.chapters[0].summary).toBe('核心职责说明');
      expect(parsed.data.chapters[0].targetPaths).toEqual(['src/core']);
      expect(parsed.data.chapters[0].phase).toBe('入门'); // 自动推导
    }
  });

  it('🧪 [TC-FUNNEL-FAIL-CLOSED-ON-TRUE-GARBAGE] 模型输出真垃圾或空章节时，坚决 Fail-Closed，绝伪装成功', () => {
    const raw1 = { error: 'LLM rate limit reached' };
    const raw2 = { chapters: [] };

    const norm1 = planPurpose.normalizeOutput!(raw1);
    const norm2 = planPurpose.normalizeOutput!(raw2);

    expect(planPurpose.schema!.safeParse(norm1).success).toBe(false);
    expect(planPurpose.schema!.safeParse(norm2).success).toBe(false);
  });

  it('🧪 [TC-FUNNEL-STRIP-CODE-EXTENSIONS] 确定性消除章节名称中模型泄露的代码物理扩展名（如 .py, .go, .ts 等），保护 Node.js 等专有名词', () => {
    // 单元断言 cleanChapterName
    expect(cleanChapterName('第 1 章: 项目全景与训练入口 train.py')).toBe('第 1 章: 项目全景与训练入口');
    expect(cleanChapterName('第 2 章: 分布式基础设施 utils.py')).toBe('第 2 章: 分布式基础设施');
    expect(cleanChapterName('第 3 章: 偏好数据管线 preference_datasets.py')).toBe('第 3 章: 偏好数据管线');
    expect(cleanChapterName('第 2 章：领域类型与配置模型 types.go')).toBe('第 2 章：领域类型与配置模型');
    expect(cleanChapterName('第 5 章：HTTP 协议请求引擎 request.go')).toBe('第 5 章：HTTP 协议请求引擎');
    expect(cleanChapterName('第 1 章: 项目入口 (train.py)')).toBe('第 1 章: 项目入口');
    expect(cleanChapterName('第 1 章: train.py')).toBe('第 1 章: train');
    expect(cleanChapterName('Chapter 1: Training Entrypoint train.py')).toBe('Chapter 1: Training Entrypoint');
    expect(cleanChapterName('第 1 章: Node.js 异步运行时')).toBe('第 1 章: Node.js 异步运行时');
    expect(cleanChapterName('第 1 章: Python 异步并发与 PyTorch 实战')).toBe('第 1 章: Python 异步并发与 PyTorch 实战');

    // 漏斗集成：normalizeOutlineMap 自动收敛清洗
    const rawMap = {
      chapters: [
        {
          name: '第 1 章: 项目全景与训练入口 train.py',
          summary: '训练入口',
          files: ['train.py'],
          phase: '入门',
        },
        {
          name: '第 2 章: 分布式基础设施 utils.py',
          summary: '基础设施',
          files: ['utils.py'],
          phase: '进阶',
        },
        {
          name: '第 3 章: DPO 损失与 BasicTrainer 基础训练器',
          summary: '损失计算',
          files: ['trainers.py'],
          phase: '实战',
        },
      ],
    };

    const mapPurpose = lookupLlmPurpose('outline_map_v1')!;
    const normalized = mapPurpose.normalizeOutput!(rawMap) as any;
    expect(normalized.chapters[0].name).toBe('第 1 章: 项目全景与训练入口');
    expect(normalized.chapters[1].name).toBe('第 2 章: 分布式基础设施');
    expect(normalized.chapters[2].name).toBe('第 3 章: DPO 损失与 BasicTrainer 基础训练器');
  });

  it('🧪 [TC-FUNNEL-STRIP-ABSTRACT-JARGON-AND-PAREN-SYMBOLS] 确定性消除章节名称中模型泄露的括号罗列符号清单与前置抽象架构维度套话', () => {
    // 单元断言 cleanChapterName
    expect(cleanChapterName('第 1 章: 门面契约与域名匹配体系 (Domain、NewDomain 与 matcherset)')).toBe(
      '第 1 章: 域名匹配体系'
    );
    expect(cleanChapterName('第 2 章: 网络领域模型: 地址、端口与多缓冲区 (Address、Port、multi_buffer)')).toBe(
      '第 2 章: 地址、端口与多缓冲区'
    );
    expect(cleanChapterName('第 3 章: 信号生命周期与序列化基础 (Done、Instance 与字符串工具)')).toBe(
      '第 3 章: 信号生命周期与序列化基础'
    );
    expect(cleanChapterName('第 4 章: 核心执行引擎: 命令框架与错误处理管线 (Command、errors)')).toBe(
      '第 4 章: 命令框架与错误处理管线'
    );
    expect(
      cleanChapterName('Chapter 1: Interface & Facade: Routing and Domain Matching (Domain, NewDomain and matcherset)')
    ).toBe('Chapter 1: Routing and Domain Matching');
    expect(cleanChapterName('Chapter 2: Core Engine: Command Framework and Errors (Command, errors)')).toBe(
      'Chapter 2: Command Framework and Errors'
    );

    // 漏斗集成：normalizeOutlineMap 自动收敛清洗抽象标题与末尾括号符号清单
    const rawMap = {
      chapters: [
        {
          name: '第 1 章: 门面契约与域名匹配体系 (Domain、NewDomain 与 matcherset)',
          summary: '域名匹配体系解析',
          files: ['common/router.go'],
          phase: '入门',
        },
        {
          name: '第 2 章: 网络领域模型: 地址、端口与多缓冲区 (Address、Port、multi_buffer)',
          summary: '地址与缓冲区机制',
          files: ['common/net.go'],
          phase: '入门',
        },
        {
          name: '第 3 章: 核心执行引擎: 命令框架与错误处理管线 (Command、errors)',
          summary: '命令框架与调度管线',
          files: ['app/dispatcher.go'],
          phase: '进阶',
        },
      ],
    };

    const mapPurpose = lookupLlmPurpose('outline_map_v1')!;
    const normalized = mapPurpose.normalizeOutput!(rawMap) as any;
    expect(normalized.chapters[0].name).toBe('第 1 章: 域名匹配体系');
    expect(normalized.chapters[1].name).toBe('第 2 章: 地址、端口与多缓冲区');
    expect(normalized.chapters[2].name).toBe('第 3 章: 命令框架与错误处理管线');
  });
});
