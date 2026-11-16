import { describe, expect, it } from 'vitest';
import { buildModuleArchitectureMermaidSkeleton } from '@/lib/mermaid/architecture-skeleton';

describe('buildModuleArchitectureMermaidSkeleton (确定性 Mermaid 拓扑骨架生成器)', () => {
  it('CallFlow 物理事实渲染：生成有效 Mermaid 节点与调用边', () => {
    const cog = {
      phase: 'phase3_pipeline' as const,
      phaseOrder: 2,
      rationale: 'Core pipeline processing',
      callFlow: [
        { caller: 'ParseEvent', callee: 'ValidateEvent' },
        { caller: 'ValidateEvent', callee: 'EmitRecord' },
      ],
      upstreamModules: ['IngestSource'],
      downstreamModules: ['StorageSink'],
    };

    const skeleton = buildModuleArchitectureMermaidSkeleton('Pipeline Engine', cog);
    expect(skeleton).toContain('```mermaid\nflowchart TD');
    expect(skeleton).toContain('subgraph ChapterMod["Pipeline Engine"]');
    expect(skeleton).toContain('fn1["ParseEvent()"]');
    expect(skeleton).toContain('fn2["ValidateEvent()"]');
    expect(skeleton).toContain('fn1 --> fn2');
    expect(skeleton).toContain('fn3["EmitRecord()"]');
    expect(skeleton).toContain('fn2 --> fn3');
    expect(skeleton).toContain('up1(["Prerequisite: IngestSource"]) --> fn1');
    expect(skeleton).toContain('fn3 --> down1(["Dependent: StorageSink"])');
    expect(skeleton.endsWith('```')).toBe(true);
  });

  it('GoldenSymbols 降级：无 CallFlow 时使用核心符号骨架', () => {
    const golden = [
      { name: 'Store', file: 'store.ts', kind: 'type' },
      { name: 'createStore', file: 'store.ts', kind: 'function' },
    ];

    const skeleton = buildModuleArchitectureMermaidSkeleton('Store Module', null, golden, {
      includeExternal: false,
    });

    expect(skeleton).toContain('subgraph ChapterMod["Store Module"]');
    expect(skeleton).toContain('fn1["Store (type)"]');
    expect(skeleton).toContain('fn2["createStore (function)"]');
    expect(skeleton).toContain('fn1 -.-> fn2');
    expect(skeleton).not.toContain('Prerequisite:');
  });

  it('双空极简兜底与引号安全转义', () => {
    const skeleton = buildModuleArchitectureMermaidSkeleton('My "Cool" Module', null, null, {
      includeExternal: false,
    });

    expect(skeleton).toContain('subgraph ChapterMod["My \'\'Cool\'\' Module"]');
    expect(skeleton).toContain('fn1["My \'\'Cool\'\' Module Core"]');
  });
});
