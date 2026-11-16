import { describe, it, expect } from 'vitest';
import {
  generateEditionKey,
  resolveEditionForKey,
  buildRepoEditionGroups,
  sameSourceEditionGroupKey,
  resolveEditionChipDisplayLabel,
} from '@/lib/edition';
import { deriveEditionLabel, editionParamFromUrl } from '@/lib/repository-resolver';

describe('generateEditionKey', () => {
  it("生成 ed_ + 8 位 hex 的短 key（空串保留给基础讲法）", () => {
    const key = generateEditionKey();
    expect(key).toMatch(/^ed_[0-9a-f]{8}$/);
    expect(key).not.toBe('');
  });

  it('两次生成不相等（防两用户同名讲法撞唯一键）', () => {
    expect(generateEditionKey()).not.toBe(generateEditionKey());
  });
});

describe('resolveEditionForKey', () => {
  it('显式 edition 透传并 trim', () => {
    expect(resolveEditionForKey({ edition: 'ed_abcd1234' })).toBe('ed_abcd1234');
    expect(resolveEditionForKey({ edition: '  ed_abcd1234  ' })).toBe('ed_abcd1234');
  });

  it('空白字符串 edition 视为未指定（回落基础讲法）', () => {
    expect(resolveEditionForKey({ edition: '   ' })).toBe('');
  });

  it('createEdition=true 生成新讲法 key', () => {
    expect(resolveEditionForKey({ createEdition: true })).toMatch(/^ed_[0-9a-f]{8}$/);
  });

  it('显式 edition 优先于 createEdition（重导入场景）', () => {
    expect(resolveEditionForKey({ edition: 'ed_00000000', createEdition: true })).toBe('ed_00000000');
  });

  it('两者皆无 → 基础讲法（现状语义）', () => {
    expect(resolveEditionForKey({})).toBe('');
    expect(resolveEditionForKey({ createEdition: false })).toBe('');
  });
});

describe('deriveEditionLabel', () => {
  it('显式个性化标题优先（排除机生占位符与“教学解读版”）', () => {
    expect(deriveEditionLabel({ editionLabel: 'JS 类比版', transcriptionPreset: 'analogy' })).toBe('JS 类比版');
    expect(deriveEditionLabel({ editionLabel: '教学解读版', transcriptionPreset: 'standard' })).toBe('标准教程');
    expect(deriveEditionLabel({ editionLabel: '教学解读', transcriptionPreset: 'standard' })).toBe('标准教程');
  });

  it('存在转录模型时，首选以转录模型区分版本', () => {
    expect(deriveEditionLabel({ transcriptionPreset: 'standard' }, ['qwen3.8-max'])).toBe('qwen3.8-max');
    expect(deriveEditionLabel({ editionLabel: '讲法 ed_d09bdeae' }, ['qwen3.8-max'])).toBe('qwen3.8-max');
    expect(deriveEditionLabel(null, ['qwen3.8-flash'])).toBe('qwen3.8-flash');
  });

  it('transcriptionModels 为空但 profile 包含 transcriptionModel/model 时优先以模型命名', () => {
    expect(deriveEditionLabel({ transcriptionModel: 'glm-5.3-flash', editionPreset: 'standard' })).toBe('glm-5.3-flash');
    expect(deriveEditionLabel({ model: 'qwen-max', transcriptionPreset: 'standard' })).toBe('qwen-max');
    expect(deriveEditionLabel({ activeModel: 'qwen3.8-flash', editionPreset: 'deep' })).toBe('qwen3.8-flash');
  });

  it('无转录模型且无 editionLabel 时回落非标转录预设名 + 「版」后缀', () => {
    expect(deriveEditionLabel({ transcriptionPreset: 'analogy' })).toBe('类比桥接版');
    expect(deriveEditionLabel({ editionPreset: 'cheatsheet' })).toBe('速查手册版');
  });

  it('standard 预设绝不渲染为“教学解读版”，统一回落为“标准教程”', () => {
    expect(deriveEditionLabel({ transcriptionPreset: 'standard' })).toBe('标准教程');
    expect(deriveEditionLabel({ editionPreset: 'standard' })).toBe('标准教程');
  });

  it('无信息 → 标准教程兜底', () => {
    expect(deriveEditionLabel(null)).toBe('标准教程');
    expect(deriveEditionLabel({})).toBe('标准教程');
  });
});

describe('resolveEditionChipDisplayLabel', () => {
  it('优先使用转录模型作为版本区分，并忽略机生占位符、“教学解读版”与默认标签', () => {
    expect(resolveEditionChipDisplayLabel({
      label: '讲法 ed_d09bdeae',
      transcriptionModels: ['qwen3.8-max'],
      isDefault: true,
    })).toBe('qwen3.8-max');

    expect(resolveEditionChipDisplayLabel({
      label: '教学解读版',
      transcriptionModels: ['glm-5.3-flash'],
      isDefault: false,
    })).toBe('glm-5.3-flash');

    expect(resolveEditionChipDisplayLabel({
      label: '标准教程',
      transcriptionModels: ['qwen3.8-flash'],
      isDefault: false,
    })).toBe('qwen3.8-flash');

    expect(resolveEditionChipDisplayLabel({
      label: '教学解读版',
      transcriptionModels: [],
      isDefault: false,
    })).toBe('标准教程');
  });

  it('保留用户手动命名的有效个性化标题', () => {
    expect(resolveEditionChipDisplayLabel({
      label: '小白速成指南',
      transcriptionModels: ['qwen3.8-max'],
      isDefault: false,
    })).toBe('小白速成指南');
  });
});

describe('editionParamFromUrl', () => {
  it('读取 ?edition= 查询参数', () => {
    expect(editionParamFromUrl(new Request('https://x.dev/api?edition=ed_ab12'))).toBe('ed_ab12');
  });

  it('缺省返回基础讲法', () => {
    expect(editionParamFromUrl(new Request('https://x.dev/api'))).toBe('');
  });

  it('异常输入不抛错', () => {
    expect(editionParamFromUrl({} as Request)).toBe('');
  });
});

describe('buildRepoEditionGroups', () => {
  const row = (id: string, owner: string, repo: string, edition: string, updatedAt: string) =>
    ({ id, owner, repo, edition, updatedAt } as const);

  it('单行组：siblings 空、editionCount=1（单讲法卡片零变化）', () => {
    const groups = buildRepoEditionGroups([row('1', 'tokio-rs', 'tokio', '', '2026-01-01')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].primary.id).toBe('1');
    expect(groups[0].siblings).toHaveLength(0);
    expect(groups[0].editionCount).toBe(1);
  });

  it('多讲法组：基础行作 primary，讲法行按 key 字典序作 siblings', () => {
    const groups = buildRepoEditionGroups([
      row('a', 'tokio-rs', 'tokio', 'ed_bb', '2026-01-03'),
      row('b', 'tokio-rs', 'tokio', '', '2026-01-01'),
      row('c', 'tokio-rs', 'tokio', 'ed_aa', '2026-01-02'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].primary.id).toBe('b');
    expect(groups[0].siblings.map((s) => s.id)).toEqual(['c', 'a']);
    expect(groups[0].editionCount).toBe(3);
  });

  it('无基础行时取 updatedAt 最新作 primary（确定性兜底）', () => {
    const groups = buildRepoEditionGroups([
      row('a', 'o', 'r', 'ed_aa', '2026-01-01'),
      row('b', 'o', 'r', 'ed_bb', '2026-03-01'),
      row('c', 'o', 'r', 'ed_cc', '2026-02-01'),
    ]);
    expect(groups[0].primary.id).toBe('b');
    expect(groups[0].siblings.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('owner/repo 大小写不敏感分组，不同仓库各自成组', () => {
    const groups = buildRepoEditionGroups([
      row('1', 'Tokio-RS', 'tokio', '', '2026-01-01'),
      row('2', 'tokio-rs', 'tokio', 'ed_aa', '2026-01-02'),
      row('3', 'vercel', 'next.js', '', '2026-01-01'),
    ]);
    expect(groups).toHaveLength(2);
    const tokio = groups.find((g) => g.primary.repo === 'tokio')!;
    expect(tokio.editionCount).toBe(2);
    const next = groups.find((g) => g.primary.repo === 'next.js')!;
    expect(next.editionCount).toBe(1);
  });

  it('同源簇组键：sourceClusterKey 相同的不同仓库归为一组（clone 转录归卡）', () => {
    const rows = [
      { ...row('1', 'original', 'repo', '', '2026-01-01'), sourceClusterKey: 'cluster-a' },
      { ...row('2', 'cloner', 'repo-copy', '', '2026-01-02'), sourceClusterKey: 'cluster-a' },
      { ...row('3', 'other', 'unrelated', '', '2026-01-01'), sourceClusterKey: null },
    ];
    const groups = buildRepoEditionGroups(rows, { groupKey: sameSourceEditionGroupKey });
    expect(groups).toHaveLength(2);
    const cluster = groups.find((g) => g.primary.sourceClusterKey === 'cluster-a')!;
    expect(cluster.editionCount).toBe(2);
    // 主行选择确定性：跨仓簇的两行均为基础讲法（edition=''）时按稳定序取首行
    // （实际主行质量由 page.tsx 传入的已排序列表前置保证——分组函数只保证确定性，不做质量判断）
    expect(cluster.primary.id).toBe('1');
    expect(cluster.siblings.map((s) => s.id)).toEqual(['2']);
  });

  it('跨分支与簇键漂移防护：同 (owner, repo) 无论 sourceClusterKey 是否一致均保证归为同组', () => {
    const rows = [
      { ...row('1', 'projectdiscovery', 'nuclei', 'ed_max', '2026-10-04'), sourceClusterKey: 'hash-dev' },
      { ...row('2', 'projectdiscovery', 'nuclei', '', '2026-09-23'), sourceClusterKey: null },
    ];
    const groups = buildRepoEditionGroups(rows, { groupKey: sameSourceEditionGroupKey });
    expect(groups).toHaveLength(1);
    expect(groups[0].editionCount).toBe(2);
    expect(groups[0].primary.id).toBe('2'); // 基础行优先
    expect(groups[0].siblings[0].id).toBe('1');
  });
});
