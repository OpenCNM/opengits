import { describe, expect, it } from 'vitest';
import {
  matchScoutVersion,
  fallbackPrefix,
  VERSION_MATCHERS,
  byExplicitPath,
  byPrimaryRole,
  ScoutVersionLike,
} from '@/lib/import-wizard/version-matchers';
import { mergeVerdictIntoVersions, type DirVerdict } from '@/lib/dir-verdict';

// 保障责任链不被误改（新增/删除策略应显式更新此断言）
describe('VERSION_MATCHERS 责任链契约（两环：URL 显式子路径 → AI 裁决 primary）', () => {
  it('责任链长度固定为 2', () => {
    expect(VERSION_MATCHERS).toHaveLength(2);
  });
});

const v = (over: Partial<ScoutVersionLike>): ScoutVersionLike => ({
  prefix: '/docs/',
  totalFiles: 10,
  ...over,
});

describe('byExplicitPath（用户 URL 明示意图）', () => {
  const versions: ScoutVersionLike[] = [
    v({ prefix: 'changelogs/' }),
    v({ prefix: '', totalFiles: 100 }),
    v({ prefix: 'docs/', role: 'primary' }),
  ];

  it('精确/尾斜杠归一匹配', () => {
    expect(byExplicitPath(versions, { filePath: 'docs' })?.prefix).toBe('docs/');
    expect(byExplicitPath(versions, { filePath: 'docs/' })?.prefix).toBe('docs/');
    expect(byExplicitPath(versions, { filePath: null })).toBeNull();
  });

  it('空串漂移防御：根目录条目 prefix=\'\' 不再经 endsWith 恒真劫持显式路径', () => {
    // 回归向量：旧实现中 '' 恒真命中，root 排在数组首位时 docs 请求被劫持为根
    const rootFirst = [v({ prefix: '' }), v({ prefix: 'docs/' })];
    expect(byExplicitPath(rootFirst, { filePath: 'docs' })?.prefix).toBe('docs/');
    // 无匹配时返回 null：根目录只能经 primary 角色或 fallback 默认到达
    expect(byExplicitPath(rootFirst, { filePath: 'changelogs' })).toBeNull();
  });
});

describe('byPrimaryRole（AI 裁决主体，根目录合法化）', () => {
  it('LLM 裁决的正文目录命中 primary；\'\' 仓库根同为合法主体答案', () => {
    expect(byPrimaryRole([v({ prefix: 'docs/', role: 'primary' })])?.prefix).toBe('docs/');
    expect(byPrimaryRole([v({ prefix: '', role: 'primary' }), v({ prefix: 'appendix-A/' })])?.prefix).toBe('');
  });

  it('无 primary 角色时返回 null（不再按字母序/丰富度盲猜兜底）', () => {
    expect(byPrimaryRole([v({ prefix: 'appendix-A/' }), v({ prefix: 'ch01/' })])).toBeNull();
  });
});

describe('matchScoutVersion 端到端（appendix-A 盲选事故回归）', () => {
  it('平铺书仓：AI 裁决根目录主体后，字母序首个子目录不得上位', () => {
    const versions: ScoutVersionLike[] = [
      v({ prefix: '', role: 'primary', totalFiles: 100 }), // AI: 全仓根即教程主体
      v({ prefix: 'appendix-A/', totalFiles: 3 }), // 字母序陷阱：旧规则会盲选它
      v({ prefix: 'ch01/', totalFiles: 8 }),
    ];
    expect(matchScoutVersion(versions, { filePath: null })?.prefix).toBe('');
  });

  it('URL 显式子路径优先于 AI 裁决（用户明示 > AI 推断）', () => {
    const versions: ScoutVersionLike[] = [
      v({ prefix: '', role: 'primary' }),
      v({ prefix: 'packages/reactivity/', totalFiles: 5 }),
    ];
    expect(matchScoutVersion(versions, { filePath: 'packages/reactivity' })?.prefix).toBe('packages/reactivity/');
  });

  it('两环皆空 → null（无自动推荐，人工选择兜底）', () => {
    expect(matchScoutVersion([v({ prefix: 'a/' }), v({ prefix: 'b/' })], { filePath: null })).toBeNull();
  });
});

describe('scope-verdict → 版本合并 → 匹配链 全链路', () => {
  it('AI 裁决根目录经 mergeVerdictIntoVersions 附着 primary 后可被匹配链命中', () => {
    // scope-verdict.toDirVerdict 的等价产物（根 primary + 辅助目录，纯数据契约）
    const verdict: DirVerdict = {
      primaryRoot: '',
      candidates: [
        { dir: '', lang: null, role: 'primary', confidence: 1, reason: 'ch01~ch07 平铺于仓库根' },
        { dir: 'setup/', lang: null, role: 'auxiliary', confidence: 1 },
        { dir: 'pkg/', lang: null, role: 'auxiliary', confidence: 1 },
      ],
    };
    const heuristic = [
      { name: 'Root / Main Content', prefix: '' },
      { name: 'Appendix-a', prefix: 'appendix-A/' },
    ];
    const merged = mergeVerdictIntoVersions(heuristic, verdict);
    expect(merged.find((x) => x.prefix === '')?.role).toBe('primary');
    // auxiliary 一律不进候选菜单（仅供前端排除勾选）
    expect(merged.some((x) => x.prefix === 'setup/')).toBe(false);
    expect(matchScoutVersion(merged, { filePath: null })?.prefix).toBe('');
  });
});

describe('fallbackPrefix（无推荐时的最不坏默认）', () => {
  it('URL 子路径补斜杠；无子路径默认仓库根（超集，用户仍可改选）', () => {
    expect(fallbackPrefix('sub/dir')).toBe('sub/dir/');
    expect(fallbackPrefix('sub/dir/')).toBe('sub/dir/');
    expect(fallbackPrefix(null)).toBe('');
    expect(fallbackPrefix(undefined)).toBe('');
  });
});
