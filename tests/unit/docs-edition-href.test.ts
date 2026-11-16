import { describe, expect, it } from 'vitest';
import { resolveEditionHref } from '@/components/docs/DocsEdition';

const OWNER = 'karpathy';
const REPO = 'micrograd';
const BASE = `/docs/${OWNER}/${REPO}`;

/** 构造 fumadocs PageTree 形状的树（page.url / folder.children / folder.root） */
const treeOf = (urls: string[]) => ({
  children: urls.map((url, i) =>
    i === 0 ? { name: 'root-folder', root: { name: '首章', url }, children: [] } : { name: `p${i}`, url }
  ),
});

describe('讲法切换直链解析（跨讲法 404 根因修复）', () => {
  const deepTree = treeOf([
    `${BASE}/01-intro`,
    `${BASE}/02-engine`,
    `${BASE}/03-advanced`,
  ]);

  it('当前 slug 在目标讲法树中存在 → 沿用当前路径仅切 ?edition=（保留读者位置）', () => {
    expect(
      resolveEditionHref({
        targetEdition: 'ed_deep',
        isDefault: false,
        pathname: `${BASE}/02-engine`,
        owner: OWNER,
        repo: REPO,
        tree: deepTree,
      })
    ).toBe(`${BASE}/02-engine?edition=ed_deep`);
  });

  it('当前 slug 不属于目标讲法拓扑 → 直链目标讲法教学序首章', () => {
    expect(
      resolveEditionHref({
        targetEdition: 'ed_deep',
        isDefault: false,
        pathname: `${BASE}/legacy-only-in-base`,
        owner: OWNER,
        repo: REPO,
        tree: deepTree,
      })
    ).toBe(`${BASE}/01-intro?edition=ed_deep`);
  });

  it('切回默认讲法且 slug 缺失 → 直链默认讲法首章，不带 ?edition=', () => {
    expect(
      resolveEditionHref({
        targetEdition: '',
        isDefault: true,
        pathname: `${BASE}/edition-only-chapter`,
        owner: OWNER,
        repo: REPO,
        tree: deepTree,
      })
    ).toBe(`${BASE}/01-intro`);
  });

  it('目标树未构建（缺键）→ 退回旧行为，服务端精确匹配兜底接管', () => {
    expect(
      resolveEditionHref({
        targetEdition: 'ed_new',
        isDefault: false,
        pathname: `${BASE}/02-engine`,
        owner: OWNER,
        repo: REPO,
        tree: undefined,
      })
    ).toBe(`${BASE}/02-engine?edition=ed_new`);
  });

  it('根路径与 readme/index 语义等价（与侧栏激活判定同口径）', () => {
    const readmeTree = treeOf([`${BASE}`, `${BASE}/01-intro`]);
    expect(
      resolveEditionHref({
        targetEdition: 'ed_deep',
        isDefault: false,
        pathname: `${BASE}/readme`,
        owner: OWNER,
        repo: REPO,
        tree: readmeTree,
      })
    ).toBe(`${BASE}/readme?edition=ed_deep`);
  });

  it('URI 编码中文 slug 语义等价匹配', () => {
    const cnTree = treeOf([`${BASE}/01-%E5%BC%95%E8%A8%80`, `${BASE}/02-%E5%BC%95%E6%93%8E`]);
    expect(
      resolveEditionHref({
        targetEdition: 'ed_deep',
        isDefault: false,
        pathname: `${BASE}/01-引言`,
        owner: OWNER,
        repo: REPO,
        tree: cnTree,
      })
    ).toBe(`${BASE}/01-引言?edition=ed_deep`);
  });

  it('当 pathname 包含 URI 编码且 owner/repo 包含非 ASCII 字符时正确识别 slug', () => {
    const zhOwner = '张三';
    const zhRepo = '项目';
    const zhBase = `/docs/${zhOwner}/${zhRepo}`;
    const zhTree = treeOf([`${zhBase}/01-intro`, `${zhBase}/02-engine`]);
    const encodedPathname = `/docs/${encodeURIComponent(zhOwner)}/${encodeURIComponent(zhRepo)}/02-engine`;
    expect(
      resolveEditionHref({
        targetEdition: 'ed_deep',
        isDefault: false,
        pathname: encodedPathname,
        owner: zhOwner,
        repo: zhRepo,
        tree: zhTree,
      })
    ).toBe(`${encodedPathname}?edition=ed_deep`);
  });
});
