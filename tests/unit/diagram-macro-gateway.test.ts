import { describe, it, expect } from 'vitest';
import {
  assembleEnrichedMermaid,
  type MacroTopology,
  type DiagramLlmOutput,
} from '@/lib/mermaid/macro-topology-assembler';
import { lookupLlmPurpose } from '@/lib/llm-gateway/registry';

describe('MacroTopology Assembler & Gateway Purpose', () => {
  const mockPhysicalTopology: MacroTopology = {
    scope: '',
    scale: 1,
    strategy: 'directory',
    nodes: [
      {
        id: 'entrypoint',
        path: '.',
        name: 'Core Entrypoint',
        role: 'interface',
        fileCount: 3,
        loc: 400,
        hotness: 90,
      },
      {
        id: 'sub_engine',
        path: 'engine',
        name: 'engine',
        role: 'core',
        fileCount: 15,
        loc: 3200,
        hotness: 80,
      },
      {
        id: 'sub_store',
        path: 'store',
        name: 'store',
        role: 'infra',
        fileCount: 8,
        loc: 1500,
        hotness: 60,
      },
    ],
    edges: [
      {
        from: 'entrypoint',
        to: 'sub_engine',
        weight: 12,
        symbols: ['RunEngine', 'Init'],
      },
      {
        from: 'sub_engine',
        to: 'sub_store',
        weight: 8,
        symbols: ['Save', 'Query'],
      },
    ],
    rawMermaid:
      '```mermaid\nflowchart TD\n  entrypoint["Core Entrypoint"]\n  sub_engine["engine"]\n  sub_store["store"]\n  entrypoint --> sub_engine\n  sub_engine --> sub_store\n```',
    mermaid: '',
  };

  it('correctly fuses physical topology with LLM semantic JSON', () => {
    const llmOutput: DiagramLlmOutput = {
      nodes: [
        {
          id: 'entrypoint',
          title: 'CLI 控制台入口',
          subtitle: '命令行参数解析与环境初始化',
          layer: 'interface',
        },
        {
          id: 'sub_engine',
          title: '核心执行引擎',
          subtitle: '任务调度与流水线编排',
          layer: 'core',
        },
        {
          id: 'sub_store',
          title: '持久化存储底座',
          subtitle: '数据落地与快照管理',
          layer: 'infra',
        },
      ],
      edges: [
        {
          from: 'entrypoint',
          to: 'sub_engine',
          label: '分发参数并触发运行',
        },
        {
          from: 'sub_engine',
          to: 'sub_store',
          label: '写入执行结果与日志',
        },
      ],
      summary: '典型分层架构：命令行作为入口驱动引擎，结果沉降到底层存储。',
    };

    const result = assembleEnrichedMermaid(mockPhysicalTopology, llmOutput);

    expect(result).toContain('```mermaid');
    expect(result).toContain('flowchart TD');
    expect(result).toContain('CLI 控制台入口');
    expect(result).toContain('核心执行引擎');
    expect(result).toContain('持久化存储底座');
    expect(result).toContain('分发参数并触发运行');
    expect(result).toContain('写入执行结果与日志');
    expect(result).toContain('subgraph Interface');
    expect(result).toContain('subgraph Core');
    expect(result).toContain('subgraph Infra');
  });

  it('strictly prunes hallucinated nodes and edges from LLM output (Grounding Dilemma)', () => {
    const llmOutputWithHallucinations: DiagramLlmOutput = {
      nodes: [
        {
          id: 'entrypoint',
          title: 'CLI 入口',
          subtitle: '解析参数',
          layer: 'interface',
        },
        // 幻造不存在的节点
        {
          id: 'phantom_cloud_service',
          title: '云端协同服务',
          subtitle: '虚假的云端同步',
          layer: 'infra',
        },
      ],
      edges: [
        // 幻造连线
        {
          from: 'entrypoint',
          to: 'phantom_cloud_service',
          label: '虚假连接',
        },
      ],
    };

    const result = assembleEnrichedMermaid(mockPhysicalTopology, llmOutputWithHallucinations);

    // 幻造的节点与边必须被物理剔除
    expect(result).not.toContain('phantom_cloud_service');
    expect(result).not.toContain('云端协同服务');
    expect(result).not.toContain('虚假连接');

    // 物理上存在的 edge (sub_engine -> sub_store) 虽未被 LLM 提及，仍保留物理默认
    expect(result).toContain('sub_engine -->|"calls Save, Query"| sub_store');
  });

  it('falls back closed to rawMermaid when LLM output is null or malformed', () => {
    const fallback1 = assembleEnrichedMermaid(mockPhysicalTopology, null);
    expect(fallback1).toBe(mockPhysicalTopology.rawMermaid);

    const fallback2 = assembleEnrichedMermaid(mockPhysicalTopology, { nodes: [] });
    expect(fallback2).toBe(mockPhysicalTopology.rawMermaid);
  });

  it('diagram_architecture_macro_v1 purpose is registered with correct schema and compile behavior', async () => {
    const purpose = lookupLlmPurpose('diagram_architecture_macro_v1');
    expect(purpose).not.toBeNull();
    expect(purpose?.kind).toBe('structured');
    expect(purpose?.source).toBe('diagram-macro');

    // 校验 Schema
    const validJson = {
      nodes: [
        {
          id: 'sub_a',
          title: '模块 A',
          subtitle: '说明 A',
          layer: 'core' as const,
        },
      ],
      edges: [
        {
          from: 'sub_a',
          to: 'sub_b',
          label: '调用',
        },
      ],
      summary: '总结',
    };
    const parsed = purpose?.schema?.safeParse(validJson);
    expect(parsed?.success).toBe(true);

    // 校验 Compile 生成
    const compiled = await purpose!.compile({
      repoName: 'test-repo',
      nodes: [{ id: 'sub_a', name: 'a', path: 'a', fileCount: 1, loc: 10 }],
      edges: [{ from: 'sub_a', to: 'sub_b', weight: 5, symbols: ['Foo'] }],
      rawMermaid: '```mermaid\n```',
      targetLanguage: 'zh-CN',
    });

    expect(compiled).toContain('test-repo');
    expect(compiled).toContain('物理节点列表 (Nodes)');
    expect(compiled).toContain('物理调用边列表 (Edges)');
    expect(compiled).toContain('zh-CN');
  });
});
