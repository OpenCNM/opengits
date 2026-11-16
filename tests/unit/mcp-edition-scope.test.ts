import { describe, it, expect } from 'vitest';
import { foldScopeRows, parseHubRef, buildEditionHint, editionAttribution } from '@/lib/mcp/edition-scope';

const row = (id: string, owner: string, repo: string, edition: string, branch = 'main') =>
  ({ id, owner, repo, branch, edition } as const);

describe('foldScopeRows（扇出折叠）', () => {
  it('单讲法组直接保留（无折叠副作用）', () => {
    const groups = foldScopeRows([row('1', 'o', 'r', '')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].preferred.id).toBe('1');
    expect(groups[0].rows).toHaveLength(1);
  });

  it('多讲法组：最近在读行优先于基础行', () => {
    const activity = new Map([['analogy-row', Date.now()]]);
    const groups = foldScopeRows(
      [row('base-row', 'o', 'r', ''), row('analogy-row', 'o', 'r', 'ed_aa')],
      activity
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].preferred.id).toBe('analogy-row');
    expect(groups[0].rows).toHaveLength(2);
  });

  it('无阅读记录时基础行（edition 空串）优先，其余按 key 字典序', () => {
    const groups = foldScopeRows([
      row('b', 'o', 'r', 'ed_bb'),
      row('base', 'o', 'r', ''),
      row('a', 'o', 'r', 'ed_aa'),
    ]);
    expect(groups[0].preferred.id).toBe('base');
  });

  it('同阅读时间戳下按 edition 字典序破平（全确定性）', () => {
    const ts = Date.now();
    const activity = new Map([['a', ts], ['b', ts]]);
    const groups = foldScopeRows([row('b', 'o', 'r', 'ed_bb'), row('a', 'o', 'r', 'ed_aa')], activity);
    expect(groups[0].preferred.id).toBe('a');
  });

  it('不同分支不折叠（版本维度正交），owner/repo 大小写不敏感归组', () => {
    const groups = foldScopeRows([
      row('1', 'O', 'R', '', 'main'),
      row('2', 'o', 'r', 'ed_aa', 'main'),
      row('3', 'o', 'r', '', 'v15'),
    ]);
    expect(groups).toHaveLength(2);
    const main = groups.find((g) => g.key.includes('main'))!;
    expect(main.rows).toHaveLength(2);
    const v15 = groups.find((g) => g.key.includes('v15'))!;
    expect(v15.rows).toHaveLength(1);
  });
});

describe('parseHubRef（"owner/repo@edition" 引用解析）', () => {
  it('普通 owner/repo 引用：edition 为 null', () => {
    expect(parseHubRef('tokio-rs/tokio')).toEqual({ base: 'tokio-rs/tokio', edition: null });
  });

  it('带 @edition 后缀：拆出讲法 key', () => {
    expect(parseHubRef('tokio-rs/tokio@ed_ab12cd34')).toEqual({
      base: 'tokio-rs/tokio',
      edition: 'ed_ab12cd34',
    });
  });

  it('仓库 ID 引用同样支持 @edition', () => {
    expect(parseHubRef('cli123abc@ed_ff')).toEqual({ base: 'cli123abc', edition: 'ed_ff' });
  });

  it('结尾孤立 @ 视为普通引用（邮箱式误传防护）', () => {
    expect(parseHubRef('owner/repo@')).toEqual({ base: 'owner/repo@', edition: null });
  });
});

describe('editionAttribution / buildEditionHint', () => {
  it('基础行无归因后缀；讲法行追加「 · 讲法: label」', () => {
    expect(editionAttribution({ editionLabel: 'JS 类比版' }, '')).toBe('');
    expect(editionAttribution({ editionLabel: 'JS 类比版' }, 'ed_aa')).toBe(' · 讲法: JS 类比版');
    expect(editionAttribution(null, null)).toBe('');
  });

  it('buildEditionHint：无多讲法组返回空串；有多讲法组给出 @edition 指引', () => {
    expect(buildEditionHint(foldScopeRows([row('1', 'o', 'r', '')]))).toBe('');
    const groups = foldScopeRows([row('base', 'o', 'r', ''), row('a', 'o', 'r', 'ed_aa')]);
    const hint = buildEditionHint(groups);
    expect(hint).toContain('1 个仓库');
    expect(hint).toContain('o/r@ed_aa');
  });
});
