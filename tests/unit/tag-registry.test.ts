import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  getActiveTagRegistry,
  buildSeedTagRegistry,
  computeRegistryFingerprint,
  canonicalizeTag,
  classifyTags,
  splitTagsInput,
  syncTagsToRegistry,
  FALLBACK_CATEGORY,
  TAG_REGISTRY_MAX_NEW_PER_IMPORT,
  DEFAULT_TAG_REGISTRY_SEED,
  reconcileCategoryWithEvidence,
} from '@/lib/tag-registry';
import { KNOWN_CATEGORY_LABELS, normalizeCategory } from '@/lib/constants';

// ── prisma mock（syncTagsToRegistry 动态 import）──
// 2026-10-13 性能修复：逐值 upsert 收敛为 createMany + skipDuplicates（语义等价，
// N 次往返合并为 1 次；并发撞 unique 由 ON CONFLICT DO NOTHING 吞掉）
const createManyMock = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    tagRegistry: {
      createMany: (...args: unknown[]) => createManyMock(...args),
      findMany: vi.fn(),
    },
  },
}));

const registry = buildSeedTagRegistry();

// ── splitTagsInput：原始输入拆分 ──
describe('splitTagsInput', () => {
  test('中英文逗号/顿号/分号混排拆分并去空白', () => {
    expect(splitTagsInput('React，Next.js、TypeScript; Node.js')).toEqual([
      'React', 'Next.js', 'TypeScript', 'Node.js',
    ]);
  });

  test('数组原样 trim，空串丢弃', () => {
    expect(splitTagsInput([' React ', '', 'LLM'])).toEqual(['React', 'LLM']);
  });

  test('null/undefined 返回空数组', () => {
    expect(splitTagsInput(null)).toEqual([]);
    expect(splitTagsInput(undefined)).toEqual([]);
  });
});

// ── canonicalizeTag：规范值/别名归一 ──
describe('canonicalizeTag', () => {
  test('精确命中规范值（大小写不敏感）', () => {
    expect(canonicalizeTag('react', registry, 'TAG')).toBe('React');
    expect(canonicalizeTag('AI', registry, 'CATEGORY')).toBe('AI');
  });

  test('别名归一：ai/ml 与 machine learning → AI', () => {
    expect(canonicalizeTag('ai/ml', registry, 'CATEGORY')).toBe('AI');
    expect(canonicalizeTag('Machine Learning', registry, 'CATEGORY')).toBe('AI');
  });

  test('中文别名归一：云原生、系统底层、AI / 大模型等归一到 seed 规范值', () => {
    expect(canonicalizeTag('云原生', registry, 'CATEGORY')).toBe('Cloud');
    expect(canonicalizeTag('系统底层', registry, 'CATEGORY')).toBe('Systems');
    expect(canonicalizeTag('AI / 大模型', registry, 'CATEGORY')).toBe('AI');
    expect(canonicalizeTag('人工智能', registry, 'CATEGORY')).toBe('AI');
    expect(canonicalizeTag('Web 全栈', registry, 'CATEGORY')).toBe('Web');
    expect(canonicalizeTag('移动跨端', registry, 'CATEGORY')).toBe('Mobile');
    expect(canonicalizeTag('经典图书', registry, 'CATEGORY')).toBe('Others');
    expect(canonicalizeTag('经典图书', registry, 'TAG')).toBe('Book');
    expect(canonicalizeTag('官方文档', registry, 'CATEGORY')).toBe('Web Docs');
  });

  test('存量空格形式值保持原样（Web Docs 不得被改成连字符形态）', () => {
    expect(canonicalizeTag('Web Docs', registry, 'CATEGORY')).toBe('Web Docs');
    expect(canonicalizeTag('documentation', registry, 'CATEGORY')).toBe('Web Docs');
  });

  test('kind 严格池隔离：web-docs 在两个语境各自归一正确', () => {
    expect(canonicalizeTag('web-docs', registry, 'TAG')).toBe('web-docs');
    expect(canonicalizeTag('web-docs', registry, 'CATEGORY')).toBe('Web Docs');
    // 不带 kind 时分类池优先（Web Docs 类目值）
    expect(canonicalizeTag('webdocs', registry)).toBe('Web Docs');
  });

  test('词表外值返回 null，空串返回 null', () => {
    expect(canonicalizeTag('Elixir', registry, 'TAG')).toBeNull();
    expect(canonicalizeTag('   ', registry, 'TAG')).toBeNull();
  });
});

// ── classifyTags：known/unknown 分类与防膨胀闸 ──
describe('classifyTags', () => {
  test('known 去重取规范值', () => {
    const result = classifyTags(['react', 'ReactJS', 'Unknown Lib'], registry, 'TAG');
    expect(result.known).toEqual(['React']);
    expect(result.unknown).toEqual(['Unknown Lib']);
  });

  test(`unknown 截断到每仓库最多 ${TAG_REGISTRY_MAX_NEW_PER_IMPORT} 个（防膨胀闸）`, () => {
    const result = classifyTags(['Elixir', 'Haskell', 'Clojure', 'Fortran'], registry, 'TAG');
    expect(result.unknown).toHaveLength(TAG_REGISTRY_MAX_NEW_PER_IMPORT);
  });

  test('超长值（>40 字符）直接丢弃', () => {
    const result = classifyTags(['x'.repeat(41), 'React'], registry, 'TAG');
    expect(result.unknown).toEqual([]);
    expect(result.known).toEqual(['React']);
  });

  test('category 词表外值 canonicalize 为 null（严格封闭，调用方落 Others）', () => {
    const result = classifyTags(['Some New Category'], registry, 'CATEGORY');
    expect(result.known).toEqual([]);
    expect(canonicalizeTag('Some New Category', registry, 'CATEGORY')).toBeNull();
    expect(FALLBACK_CATEGORY).toBe('Others');
  });
});

// ── seed 词表完整性：KNOWN_CATEGORY_LABELS 的每个键都能被归一 ──
describe('seed 词表完整性', () => {
  test('KNOWN_CATEGORY_LABELS 除 all 外每个键都能归一到 seed 分类', () => {
    for (const key of Object.keys(KNOWN_CATEGORY_LABELS)) {
      if (key === 'all') continue;
      const canonical = canonicalizeTag(key, registry, 'CATEGORY');
      expect(canonical, `KNOWN_CATEGORY_LABELS['${key}'] 应能归一到 seed 词表`).not.toBeNull();
      expect(canonical).toBe(normalizeCategory(key));
    }
  });

  test('seed 内 value 无重复（value 全表唯一约束的前置保证）', () => {
    const values = DEFAULT_TAG_REGISTRY_SEED.map((s) => s.value.toLowerCase());
    expect(new Set(values).size).toBe(values.length);
  });

  test('FALLBACK_CATEGORY 必须在 seed 分类中（兜底值必须合法）', () => {
    expect(canonicalizeTag(FALLBACK_CATEGORY, registry, 'CATEGORY')).toBe(FALLBACK_CATEGORY);
  });
});

// ── computeRegistryFingerprint：词表指纹稳定性 ──
describe('computeRegistryFingerprint', () => {
  test('与条目顺序无关（排序后拼接）', () => {
    const a = computeRegistryFingerprint([
      { value: 'React', kind: 'TAG', aliases: [], source: 'seed' },
      { value: 'AI', kind: 'CATEGORY', aliases: [], source: 'seed' },
    ]);
    const b = computeRegistryFingerprint([
      { value: 'AI', kind: 'CATEGORY', aliases: [], source: 'seed' },
      { value: 'React', kind: 'TAG', aliases: [], source: 'seed' },
    ]);
    expect(a).toBe(b);
  });

  test('词表变更即指纹变更（LLM 缓存换 key 的前提）', () => {
    const before = computeRegistryFingerprint([{ value: 'React', kind: 'TAG', aliases: [], source: 'seed' }]);
    const after = computeRegistryFingerprint([{ value: 'React', kind: 'TAG', aliases: [], source: 'seed' }, { value: 'Rust', kind: 'TAG', aliases: [], source: 'ai' }]);
    expect(before).not.toBe(after);
  });
});

// ── syncTagsToRegistry：受控登记 ──
describe('syncTagsToRegistry', () => {
  beforeEach(() => {
    createManyMock.mockReset();
    createManyMock.mockResolvedValue({ count: 0 });
  });

  test('批量 createMany（data 带 kind/source，skipDuplicates 不覆盖既有条目）', async () => {
    await syncTagsToRegistry('TAG', ['Rust', 'Zig'], 'ai');
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(createManyMock).toHaveBeenCalledWith({
      data: [
        { value: 'Rust', kind: 'TAG', source: 'ai' },
        { value: 'Zig', kind: 'TAG', source: 'ai' },
      ],
      skipDuplicates: true,
    });
  });

  test('过滤空白/超长/空值', async () => {
    await syncTagsToRegistry('TAG', ['  ', 'x'.repeat(41), '', 'React'], 'ai');
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(createManyMock.mock.calls[0][0].data).toEqual([
      { value: 'React', kind: 'TAG', source: 'ai' },
    ]);
  });

  test('并发撞 unique（P2002）静默吞掉不抛错', async () => {
    createManyMock.mockRejectedValue(new Error('P2002: Unique constraint failed'));
    await expect(syncTagsToRegistry('TAG', ['Rust'], 'ai')).resolves.toBeUndefined();
  });

  test('DB 不可用时不阻断主链路（整体异常吞掉）', async () => {
    createManyMock.mockRejectedValue(new Error('connection refused'));
    await expect(syncTagsToRegistry('TAG', ['React'], 'ai')).resolves.toBeUndefined();
  });
});

// ── getActiveTagRegistry：DB 降级路径 ──
describe('getActiveTagRegistry', () => {
  test('DB 无数据时回退 seed 词表（结构完整）', async () => {
    const { prisma } = await import('@/lib/db');
    vi.mocked(prisma.tagRegistry.findMany).mockResolvedValue([]);
    const reg = await getActiveTagRegistry();
    expect(reg.categories.length).toBeGreaterThan(0);
    expect(reg.tags.length).toBeGreaterThan(0);
    expect(reg.fingerprint).toContain('Web Docs');
  });
});

// ── reconcileCategoryWithEvidence：第一性原理确定性收敛漏斗 ──
describe('reconcileCategoryWithEvidence (第一性原理确定性收敛漏斗)', () => {
  test('Cloud 伴生 AI 算力/推理服务标签确定性收敛到 AI', () => {
    // Fireworks / Baseten / Replicate / RunPod / Lambda Labs
    expect(reconcileCategoryWithEvidence({
      category: 'Cloud',
      tags: ['LLM Serving', 'Inference', 'Cloud AI'],
    })).toBe('AI');

    expect(reconcileCategoryWithEvidence({
      category: 'Cloud',
      tags: ['Truss', 'Model Serving', 'Docker'],
    })).toBe('AI');

    expect(reconcileCategoryWithEvidence({
      category: 'Cloud',
      tags: ['Model Hosting', 'Cloud AI', 'API'],
    })).toBe('AI');

    expect(reconcileCategoryWithEvidence({
      category: 'Cloud',
      tags: ['Cloud GPU', 'Serverless', 'Infrastructure'],
    })).toBe('AI');
  });

  test('Cloud 伴生语言底层运行时标签确定性收敛到 Systems', () => {
    // Deno / Bun / workerd
    expect(reconcileCategoryWithEvidence({
      category: 'Cloud',
      tags: ['Runtime', 'TypeScript', 'JavaScript'],
    })).toBe('Systems');

    expect(reconcileCategoryWithEvidence({
      category: 'Cloud',
      tags: ['Runtime', 'TypeScript', 'Security'],
    })).toBe('Systems');

    expect(reconcileCategoryWithEvidence({
      category: 'Cloud',
      summary: '内置安全沙箱的下一代 JavaScript 运行时系统',
    })).toBe('Systems');
  });

  test('Cloud 伴生 WebGPU 图形标签确定性收敛到 Gaming', () => {
    expect(reconcileCategoryWithEvidence({
      category: 'Cloud',
      tags: ['WebGPU', 'Graphics', '3D'],
    })).toBe('Gaming');
  });

  test('纯正后端架构/分布式系统严格保留在 Cloud（后端与云原生）', () => {
    // 12-factor / DDIA / MIT 6.824
    expect(reconcileCategoryWithEvidence({
      category: 'Cloud',
      tags: ['Cloud Architecture', 'Methodology', 'Best Practices'],
    })).toBe('Cloud');

    expect(reconcileCategoryWithEvidence({
      category: 'Cloud',
      tags: ['Distributed Systems', 'Architecture', 'Book'],
    })).toBe('Cloud');

    expect(reconcileCategoryWithEvidence({
      category: 'Cloud',
      tags: ['Distributed Systems', 'Go', 'Course'],
    })).toBe('Cloud');
  });

  test('非 Cloud 分类不越界重收敛（防 storage 误中 rag 假阳性）', () => {
    // SPDK 包含 Storage，不得因为包含 rag 子串被误判为 AI
    expect(reconcileCategoryWithEvidence({
      category: 'Systems',
      tags: ['SPDK', 'Storage', 'NVMe'],
    })).toBe('Systems');
  });
});

