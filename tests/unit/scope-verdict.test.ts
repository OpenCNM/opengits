import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Scout 目标目录裁决（scope-verdict）单测：
 * 纯函数回查门（groundScopeVerdict）+ BYOK fail-closed 两态 + 缓存去重。
 * LLM 网关与用户模型解析全部 mock（无网络 / 无 DB）。
 */

vi.mock('@/lib/ai', () => ({
  generateStructured: vi.fn(),
  trackTokenUsage: vi.fn(),
}));

vi.mock('@/lib/prompt-registry', () => ({
  PromptRegistry: {
    getCompiledPrompt: vi.fn(async () => ({ compiledPrompt: 'compiled-prompt' })),
  },
}));

vi.mock('@/lib/ai/user-model-resolver', () => ({
  resolveActiveUserModel: vi.fn(),
  toInjectableStructuredModel: (m: unknown) => (m ? ({ mockModel: true } as never) : undefined),
}));

import { generateStructured } from '@/lib/ai';
import { resolveActiveUserModel } from '@/lib/ai/user-model-resolver';
import {
  arbitrateScopeVerdict,
  groundScopeVerdict,
  toDirVerdict,
} from '@/lib/scout/pipeline/scope-verdict';
import { buildDirEvidence } from '@/lib/scout/pipeline/ingest-mode-arbiter';
import type { DirTreeNode } from '@/lib/dir-verdict';
import type { GitHubNode } from '@/engine/fetcher';

const generateStructuredMock = vi.mocked(generateStructured);
const resolveActiveUserModelMock = vi.mocked(resolveActiveUserModel);

const node = (path: string): GitHubNode =>
  ({ path, mode: '100644', type: 'blob', sha: 's', url: `https://example/${path}` }) as GitHubNode;

const dir = (
  path: string,
  mdCount = 3,
  codeCount = 0,
  primaryLang?: string,
  keyFiles?: string[],
): DirTreeNode => ({
  path,
  name: path.replace(/\/$/, '').split('/').pop() || '',
  depth: path.split('/').filter(Boolean).length,
  mdCount,
  codeCount,
  primaryLang,
  keyFiles,
  totalFiles: mdCount + codeCount,
  children: [],
});

/** llms-from-scratch 平铺书仓拓扑（appendix-A 盲选事故回归载体） */
const flatBookTree: DirTreeNode[] = [
  dir('ch01/'), dir('ch02/'), dir('ch03/'),
  dir('appendix-A/'), dir('appendix-B/'),
  dir('setup/'), dir('pkg/'), dir('.github/'),
];
const flatBookFiles: GitHubNode[] = [
  node('README.md'),
  node('ch01/ch01.ipynb'), node('ch01/setup.md'),
  node('ch02/ch02.ipynb'), node('appendix-A/a.md'),
  node('appendix-A/b.md'), node('appendix-A/c.md'),
];

const baseInput = {
  dirTree: flatBookTree,
  markdownFiles: flatBookFiles,
  docCodeRatio: { ratio: 0.4, docFiles: 7, codeFiles: 2 } as never,
  owner: 'rasbt',
  repo: 'llms-from-scratch',
  sha: 'abc123',
  userId: 'u1',
};

beforeEach(() => {
  generateStructuredMock.mockReset();
  resolveActiveUserModelMock.mockReset();
});

describe('groundScopeVerdict（确定性回查门·纯函数）', () => {
  const raw = (over: Partial<{ targetRoot: string; auxiliaryPaths: string[]; rationale: string }> = {}) => ({
    targetRoot: '',
    auxiliaryPaths: [] as string[],
    rationale: '章节平铺于根',
    ...over,
  });

  it('根目录合法：\'\' 与 \'/\' 归一为 \'\'，通过回查', () => {
    expect(groundScopeVerdict(raw({ targetRoot: '' }), flatBookTree, flatBookFiles)?.targetRoot).toBe('');
    expect(groundScopeVerdict(raw({ targetRoot: '/' }), flatBookTree, flatBookFiles)?.targetRoot).toBe('');
  });

  it('targetRoot 编造路径 → 整体作废返回 null（fail-closed，不猜替代目录）', () => {
    expect(groundScopeVerdict(raw({ targetRoot: 'nonexistent/' }), flatBookTree, flatBookFiles)).toBeNull();
  });

  it('auxiliaryPaths：尾斜杠归一、编造条目剔除、targetRoot 祖先/自身剔除、去重', () => {
    const verdict = groundScopeVerdict(
      raw({
        targetRoot: 'docs/',
        auxiliaryPaths: ['setup', 'pkg/', 'ghost-dir/', '', 'docs/', 'docs', 'setup/'],
      }),
      [dir('docs/'), dir('setup/'), dir('pkg/')],
      [node('docs/a.md'), node('setup/x.py'), node('pkg/y.py')]
    );
    expect(verdict?.targetRoot).toBe('docs/');
    // setup(无斜杠)→归一收录；pkg/ 收录；ghost-dir/ 编造剔除；'' 祖先剔除；
    // docs/ 自身剔除；重复 setup/ 去重
    expect(verdict?.auxiliaryPaths).toEqual(['setup/', 'pkg/']);
  });

  it('树内无 md 的目录仍可作 auxiliary（存在性即判据，不要求文档数）', () => {
    const verdict = groundScopeVerdict(
      raw({ targetRoot: '', auxiliaryPaths: ['assets/'] }),
      [dir('assets/', 0)],
      [node('README.md')]
    );
    expect(verdict?.auxiliaryPaths).toEqual(['assets/']);
  });

  it('与仓库同名的核心代码包严禁作为 auxiliary 排除，且自动清洗误判 rationale', () => {
    const verdict = groundScopeVerdict(
      raw({
        targetRoot: '',
        auxiliaryPaths: ['micrograd/', 'test/'],
        rationale: 'micrograd/ 为产品代码包、test/ 为测试目录，均属辅助噪声',
      }),
      [dir('micrograd/'), dir('test/')],
      [node('README.md'), node('micrograd/engine.py')],
      { repo: 'micrograd' }
    );
    expect(verdict?.targetRoot).toBe('');
    // micrograd/ 属于与 repo 同名的核心代码包，必须被剔除出 auxiliaryPaths
    expect(verdict?.auxiliaryPaths).toEqual(['test/']);
    // rationale 中误判核心代码为辅助噪声的幻觉被清洗修正
    expect(verdict?.rationale).not.toContain('产品代码');
    expect(verdict?.rationale).not.toContain('辅助噪声');
  });

  it('通用源码目录如 src/、core/ 与 lib/ 同样受保护，绝不进入 auxiliaryPaths', () => {
    const verdict = groundScopeVerdict(
      raw({
        targetRoot: '',
        auxiliaryPaths: ['src/', 'core/', 'lib/', '.github/'],
      }),
      [dir('src/'), dir('core/'), dir('lib/'), dir('.github/')],
      [node('README.md')],
      { repo: 'any-repo' }
    );
    expect(verdict?.auxiliaryPaths).toEqual(['.github/']);
  });
});

describe('toDirVerdict（裁决 → 版本合并契约）', () => {
  it('主体标 primary（根同样合法），辅助标 auxiliary 供前端排除', () => {
    const dv = toDirVerdict({ targetRoot: '', auxiliaryPaths: ['setup/', 'pkg/'], rationale: 'r' });
    expect(dv.primaryRoot).toBe('');
    expect(dv.candidates[0]).toMatchObject({ dir: '', role: 'primary' });
    expect(dv.candidates.slice(1).every((c) => c.role === 'auxiliary')).toBe(true);
  });
});

describe('arbitrateScopeVerdict（BYOK fail-closed 两态 + 缓存）', () => {
  it('无模型 → 直接返回 null，零 LLM 调用（不缓存：用户可能中途配置）', async () => {
    resolveActiveUserModelMock.mockResolvedValue(null);
    await expect(arbitrateScopeVerdict(baseInput)).resolves.toBeNull();
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });

  it('裁决成功：平铺书仓判根目录主体，编造辅助路径被回查剔除', async () => {
    resolveActiveUserModelMock.mockResolvedValue({ modelId: 'test-model' } as never);
    generateStructuredMock.mockResolvedValue({
      object: {
        targetRoot: '',
        auxiliaryPaths: ['setup/', 'pkg/', '.github/', 'hallucinated/'],
        rationale: 'ch01~ch07 章节平铺于仓库根',
      },
      usage: {},
    } as never);

    const verdict = await arbitrateScopeVerdict(baseInput);
    expect(verdict).not.toBeNull();
    expect(verdict?.targetRoot).toBe('');
    expect(verdict?.auxiliaryPaths).toEqual(['setup/', 'pkg/', '.github/']);
    expect(verdict?.rationale).toBe('ch01~ch07 章节平铺于仓库根');
  });

  it('裁决输出编造 targetRoot → 回查门拦截返回 null（fail-closed）', async () => {
    resolveActiveUserModelMock.mockResolvedValue({ modelId: 'test-model' } as never);
    generateStructuredMock.mockResolvedValue({
      object: { targetRoot: 'made-up-dir/', auxiliaryPaths: [], rationale: '' },
      usage: {},
    } as never);
    await expect(arbitrateScopeVerdict({ ...baseInput, owner: 'fabricated-owner' })).resolves.toBeNull();
  });

  it('LLM 连续失败（含单次重试）→ fail-closed 返回 null', async () => {
    resolveActiveUserModelMock.mockResolvedValue({ modelId: 'test-model' } as never);
    generateStructuredMock.mockRejectedValue(new Error('network down'));
    await expect(arbitrateScopeVerdict({ ...baseInput, owner: 'flaky-owner' })).resolves.toBeNull();
    // 单次重试先例：两连败才放弃
    expect(generateStructuredMock).toHaveBeenCalledTimes(2);
  });

  it('进程内缓存：同 owner/repo@sha@model 成功裁决 24h 内不重复烧 token', async () => {
    resolveActiveUserModelMock.mockResolvedValue({ modelId: 'cache-model' } as never);
    generateStructuredMock.mockResolvedValue({
      object: { targetRoot: '', auxiliaryPaths: [], rationale: 'cached' },
      usage: {},
    } as never);

    const first = await arbitrateScopeVerdict({ ...baseInput, owner: 'cache-owner' });
    const second = await arbitrateScopeVerdict({ ...baseInput, owner: 'cache-owner' });
    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    // 不同 sha 不命中缓存
    await arbitrateScopeVerdict({ ...baseInput, owner: 'cache-owner', sha: 'new-sha' });
    expect(generateStructuredMock).toHaveBeenCalledTimes(2);
  });

  it('targetLanguage 软提示：非 none 语言时注入 prompt 编译变量', async () => {
    resolveActiveUserModelMock.mockResolvedValue({ modelId: 'lang-model' } as never);
    generateStructuredMock.mockResolvedValue({
      object: { targetRoot: 'translations/zh-CN/', auxiliaryPaths: [], rationale: '翻译镜像' },
      usage: {},
    } as never);
    await arbitrateScopeVerdict({
      ...baseInput,
      owner: 'lang-owner',
      dirTree: [dir('translations/zh-CN/'), dir('translations/ja/')],
      markdownFiles: [node('translations/zh-CN/01.md'), node('translations/zh-CN/02.md'), node('translations/zh-CN/03.md')],
      targetLanguage: 'zh-CN',
    });
    const { PromptRegistry } = await import('@/lib/prompt-registry');
    const compiledVars = vi.mocked(PromptRegistry.getCompiledPrompt).mock.calls.at(-1)?.[1] as Record<string, string>;
    expect(compiledVars.targetLanguageHint).toContain('zh-CN');
  });

  it('customPrompt 软提示与 forceRefresh：注入定制偏好且跳过缓存', async () => {
    resolveActiveUserModelMock.mockResolvedValue({ modelId: 'prompt-model' } as never);
    generateStructuredMock.mockResolvedValue({
      object: { targetRoot: '', auxiliaryPaths: [], rationale: '定制裁决' },
      usage: {},
    } as never);
    await arbitrateScopeVerdict({
      ...baseInput,
      owner: 'prompt-owner',
      customPrompt: '重点关注模型架构，跳过演示',
      forceRefresh: true,
    });
    const { PromptRegistry } = await import('@/lib/prompt-registry');
    const compiledVars = vi.mocked(PromptRegistry.getCompiledPrompt).mock.calls.at(-1)?.[1] as Record<string, string>;
    expect(compiledVars.customPromptHint).toContain('重点关注模型架构');
  });

  it('开源代码库裁决：提示词注入 codebaseHint 且主包受确定性回查门严格保护', async () => {
    resolveActiveUserModelMock.mockResolvedValue({ modelId: 'test-model' } as never);
    generateStructuredMock.mockResolvedValue({
      object: {
        targetRoot: '',
        auxiliaryPaths: ['micrograd/', '.github/'],
        rationale: 'micrograd/ 为产品代码包，.github/ 为配置目录',
      },
      usage: {},
    } as never);

    const verdict = await arbitrateScopeVerdict({
      ...baseInput,
      owner: 'karpathy',
      repo: 'micrograd',
      dirTree: [
        dir('micrograd/', 0, 3, 'python', ['engine.py', 'nn.py', '__init__.py']),
        dir('.github/', 0, 0),
      ],
      markdownFiles: [node('README.md')],
      docCodeRatio: { ratio: 0.1, docFiles: 1, codeFiles: 3 } as never,
    });

    expect(verdict).not.toBeNull();
    expect(verdict?.targetRoot).toBe('');
    // micrograd/ 必须被确定性剔除，绝不可被排除
    expect(verdict?.auxiliaryPaths).toEqual(['.github/']);
    // rationale 中产品代码误判被清洗
    expect(verdict?.rationale).not.toContain('产品代码');

    const { PromptRegistry } = await import('@/lib/prompt-registry');
    const compiledVars = vi.mocked(PromptRegistry.getCompiledPrompt).mock.calls.at(-1)?.[1] as Record<string, string>;
    expect(compiledVars.codebaseHint).toContain('核心源码目录');
    expect(compiledVars.dirEvidence).toContain('3 python code files [engine.py, nn.py, __init__.py], 0 docs');
  });

  it('readmeSnippet 软提示：注入 prompt 编译变量，结合 README 研判项目类型', async () => {
    resolveActiveUserModelMock.mockResolvedValue({ modelId: 'test-model' } as never);
    generateStructuredMock.mockResolvedValue({
      object: {
        targetRoot: '',
        auxiliaryPaths: ['.github/'],
        rationale: 'README 阐明本项目为应用工具，全仓为教学主体',
      },
      usage: {},
    } as never);

    const verdict = await arbitrateScopeVerdict({
      ...baseInput,
      owner: 'openclaw',
      repo: 'openclaw',
      readmeSnippet: '# OpenClaw\n\nModular automation framework and agent engine.',
      forceRefresh: true,
    });

    expect(verdict).not.toBeNull();
    expect(verdict?.targetRoot).toBe('');

    const { PromptRegistry } = await import('@/lib/prompt-registry');
    const compiledVars = vi.mocked(PromptRegistry.getCompiledPrompt).mock.calls.at(-1)?.[1] as Record<string, string>;
    expect(compiledVars.readmeHint).toContain('OpenClaw');
    expect(compiledVars.readmeHint).toContain('Modular automation framework');
  });
});

describe('buildDirEvidence（多维物理证据格式化）', () => {
  it('代码库：目录证据正确包含代码文件数、主语言、关键文件名及文档数', () => {
    const tree: DirTreeNode[] = [
      dir('micrograd/', 0, 3, 'python', ['engine.py', 'nn.py', '__init__.py']),
      dir('test/', 0, 1, 'python', ['test_engine.py']),
      dir('docs/', 5, 0),
      dir('.github/', 0, 0),
    ];
    const evidence = buildDirEvidence(tree);
    expect(evidence).toContain('micrograd/ | 3 python code files [engine.py, nn.py, __init__.py], 0 docs | depth 1');
    expect(evidence).toContain('test/ | 1 python code files [test_engine.py], 0 docs | depth 1');
    expect(evidence).toContain('docs/ | 5 docs | depth 1');
    expect(evidence).toContain('.github/ | 0 docs | depth 1');
  });

  it('同深度活跃内容优先：代码数多的目录优先排在前面', () => {
    const tree: DirTreeNode[] = [
      dir('.github/', 0, 0),
      dir('docs/', 2, 0),
      dir('src/', 0, 10, 'typescript', ['index.ts', 'server.ts', 'router.ts']),
    ];
    const lines = buildDirEvidence(tree).split('\n');
    expect(lines[0]).toContain('src/');
    expect(lines[1]).toContain('docs/');
    expect(lines[2]).toContain('.github/');
  });
});
