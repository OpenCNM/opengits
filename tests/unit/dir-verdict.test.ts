import { test, expect } from 'vitest';
import { normalizeLocale, detectLangFromPath } from '@/lib/languages';
import { buildDirInventory, buildDirTree, validateVerdict, mergeVerdictIntoVersions, DIR_TREE_MAX_NODES, type DirCandidate } from '@/lib/dir-verdict';
import type { GitHubNode } from '@/engine/repo-sniffer';

test('normalizeLocale：别名 → 规范 ISO', () => {
  expect(normalizeLocale('zh-cn')).toBe('zh-CN');
  expect(normalizeLocale('zh_CN')).toBe('zh-CN');
  expect(normalizeLocale('zhcn')).toBe('zh-CN');
  expect(normalizeLocale('zh-hans')).toBe('zh-CN');
  expect(normalizeLocale('简体中文')).toBe('zh-CN');
  expect(normalizeLocale('chinese')).toBe('zh-CN');
  expect(normalizeLocale('cn')).toBe('zh-CN');
  expect(normalizeLocale('zh-tw')).toBe('zh-TW');
  expect(normalizeLocale('繁體中文')).toBe('zh-TW');
  expect(normalizeLocale('日本語')).toBe('ja');
  expect(normalizeLocale('english')).toBe('en');
  expect(normalizeLocale('pt-br')).toBe('pt-BR');
  expect(normalizeLocale('ZH-CN')).toBe('zh-CN');
  expect(normalizeLocale('book')).toBeNull();
  expect(normalizeLocale('')).toBeNull();
  expect(normalizeLocale(null)).toBeNull();
});

test('detectLangFromPath：任意目录布局', () => {
  expect(detectLangFromPath('translations/zh-CN/')).toBe('zh-CN');
  expect(detectLangFromPath('book-zh/')).toBe('zh-CN');
  expect(detectLangFromPath('zh-hans/')).toBe('zh-CN');
  expect(detectLangFromPath('chinese/')).toBe('zh-CN');
  expect(detectLangFromPath('docs/es-MX/')).toBe('es-MX');
  expect(detectLangFromPath('i18n/ja/')).toBe('ja');
  expect(detectLangFromPath('translations/zh-TW/')).toBe('zh-TW');
  expect(detectLangFromPath('book/')).toBeNull();
  expect(detectLangFromPath('')).toBeNull();
  expect(detectLangFromPath('images/')).toBeNull();
});


const inventoryNodes: GitHubNode[] = [
  { path: 'docs', type: 'tree' },
  { path: 'translations', type: 'tree' },
  { path: 'images', type: 'tree' },
  { path: 'translations/zh-CN', type: 'tree' },
  { path: 'translations/ja', type: 'tree' },
  { path: 'translations/zh-CN/00-intro', type: 'tree' },
  { path: 'translations/zh-CN/01-basics', type: 'tree' },
  { path: 'translations/ja/00-intro', type: 'tree' },
  { path: 'docs/guides', type: 'tree' },
  { path: 'docs/README.md', type: 'blob', size: 100 },
  { path: 'docs/guides/guide1.md', type: 'blob', size: 100 },
  { path: 'docs/guides/guide2.md', type: 'blob', size: 100 },
  { path: 'docs/guides/guide3.md', type: 'blob', size: 100 },
  { path: 'translations/zh-CN/00-intro/README.md', type: 'blob', size: 100 },
  { path: 'translations/zh-CN/00-intro/extra.md', type: 'blob', size: 100 },
  { path: 'translations/zh-CN/01-basics/README.md', type: 'blob', size: 100 },
  { path: 'translations/zh-CN/01-basics/extra.md', type: 'blob', size: 100 },
  { path: 'translations/zh-CN/01-basics/extra2.md', type: 'blob', size: 100 },
  { path: 'translations/ja/00-intro/README.md', type: 'blob', size: 100 },
  { path: 'translations/ja/00-intro/extra.md', type: 'blob', size: 100 },
  { path: 'translations/ja/00-intro/extra2.md', type: 'blob', size: 100 },
];

test('buildDirInventory：紧凑清单 + 子树计数 + 章节级过滤 + 截断', () => {
  const inventory = buildDirInventory(inventoryNodes);
  const joined = inventory.lines.join('\n');
  expect(joined).toContain('translations/zh-CN/ (5 md)');
  expect(joined).toContain('translations/ja/ (3 md)');
  expect(joined).toContain('docs/ (4 md)');
  expect(joined).toContain('images/ (0 md)');
  expect(joined.split('\n').some((l) => l.startsWith('translations/zh-CN/00-intro'))).toBe(false);
  expect(joined).toContain('children: 00-intro');
  expect(inventory.truncated).toBe(false);

  const capped = buildDirInventory(inventoryNodes, 2);
  expect(capped.lines).toHaveLength(2);
  expect(capped.truncated).toBe(true);
});

test('validateVerdict：虚构路径剔除 / 0-md 剔除 / lang 规范化 / 根字段化', () => {
  const rawVerdict = {
    primaryRoot: '',
    candidates: [
      { dir: 'translations/zh-CN/', lang: '简体中文', role: 'translation' as const, confidence: 0.95 },
      { dir: 'translations/ja/', lang: 'ja', role: 'translation' as const, confidence: 0.9 },
      { dir: 'fake/not-exists/', lang: 'zh', role: 'translation' as const, confidence: 0.99 },
      { dir: 'images/', lang: 'zh', role: 'translation' as const, confidence: 0.5 },
    ] as DirCandidate[],
  };
  const validated = validateVerdict(rawVerdict, inventoryNodes)!;
  expect(validated).toBeTruthy();
  expect(validated.candidates).toHaveLength(2);
  expect(validated.primaryRoot).toBe('');
  expect(validated.candidates.find((c) => c.dir === 'translations/zh-CN/')?.lang).toBe('zh-CN');
  expect(validated.candidates.some((c) => c.role === 'primary' && c.dir === '')).toBe(false);

  expect(validateVerdict({ primaryRoot: 'fake/', candidates: [] as DirCandidate[] }, inventoryNodes)).toBeNull();
});

test('mergeVerdictIntoVersions：覆盖/追加/辅助过滤/null 透传', () => {
  const heuristic = [
    { name: 'Root / Main Content', prefix: '' },
    { name: 'Translation (translations/zh-CN)', prefix: 'translations/zh-CN/' },
    { name: 'docs', prefix: 'docs/' },
  ];
  const validated = validateVerdict(
    {
      primaryRoot: '',
      candidates: [
        { dir: 'translations/zh-CN/', lang: '简体中文', role: 'translation' as const, confidence: 0.95 },
        { dir: 'translations/ja/', lang: 'ja', role: 'translation' as const, confidence: 0.9 },
      ] as DirCandidate[],
    },
    inventoryNodes,
  )!;
  const merged = mergeVerdictIntoVersions(heuristic, validated);
  expect(merged.find((v) => v.prefix === 'translations/zh-CN/')?.name).toBe('简体中文 (translations/zh-CN/)');
  expect(merged.find((v) => v.prefix === 'translations/zh-CN/')?.lang).toBe('zh-CN');
  expect(merged.some((v) => v.prefix === 'translations/ja/')).toBe(true);
  expect(merged.some((v) => v.prefix === 'docs/')).toBe(true);
  expect(merged.filter((v) => v.prefix === '').length).toBe(1);
  expect(merged.some((v) => v.prefix === 'images/')).toBe(false);

  expect(mergeVerdictIntoVersions(heuristic, null)).toHaveLength(heuristic.length);
});

const countTreeNodes = (nodes: { children: unknown[] }[]): number =>
  nodes.reduce((acc, n) => acc + 1 + countTreeNodes(n.children as { children: unknown[] }[]), 0);

test('buildDirTree：多语言仓(40 语言 × 19 章节)目录完整保留 + 章节自然序', () => {
  const nodes: GitHubNode[] = [{ path: 'translations', type: 'tree' }];
  for (let l = 0; l < 40; l++) {
    nodes.push({ path: `translations/lang${l}`, type: 'tree' });
    for (let c = 0; c < 19; c++) {
      const chapter = `chapter${String(c).padStart(2, '0')}`;
      nodes.push({ path: `translations/lang${l}/${chapter}`, type: 'tree' });
      nodes.push({ path: `translations/lang${l}/${chapter}/README.md`, type: 'blob', size: 100 });
    }
  }
  // 801 个目录,旧实现(全局平铺截断 500)会砍缺;完整子树口径下必须全量下发
  const tree = buildDirTree(nodes);
  expect(countTreeNodes(tree)).toBe(801);

  const translations = tree.find((n) => n.path === 'translations/')!;
  expect(translations.children).toHaveLength(40);
  for (const lang of translations.children) {
    expect(lang.children).toHaveLength(19);
  }
  expect(translations.children.map((c) => c.name)).toEqual(
    Array.from({ length: 40 }, (_, i) => `lang${i}`),
  );
  expect(translations.children[0].children.map((c) => c.name)).toEqual(
    Array.from({ length: 19 }, (_, i) => `chapter${String(i).padStart(2, '0')}`),
  );
});

test('buildDirTree：同级数字感知自然序(2-basics 在 10-advanced 之前)', () => {
  const nodes: GitHubNode[] = [];
  for (const chapter of ['10-advanced', '2-basics', '0-intro']) {
    nodes.push({ path: `book/${chapter}`, type: 'tree' });
    nodes.push({ path: `book/${chapter}/README.md`, type: 'blob', size: 100 });
  }
  const tree = buildDirTree(nodes);
  const book = tree.find((n) => n.path === 'book/')!;
  // 字典序会得到 0-intro,10-advanced,2-basics;自然序(数字感知)必须得到正确章节顺序
  expect(book.children.map((c) => c.name)).toEqual(['0-intro', '2-basics', '10-advanced']);
});

test('buildDirTree：超节点上限时整枝裁剪(完整子树,预算内无交错缺失)', () => {
  const nodes: GitHubNode[] = [];
  // 3 个顶层子树各 701 目录 → 总量 2103 超上限 2000,触发裁剪
  for (let top = 0; top < 3; top++) {
    nodes.push({ path: `t${top}`, type: 'tree' });
    for (let i = 0; i < 700; i++) {
      nodes.push({ path: `t${top}/d${i}`, type: 'tree' });
      if (i < 3) nodes.push({ path: `t${top}/d${i}/README.md`, type: 'blob', size: 100 });
    }
  }
  const tree = buildDirTree(nodes);
  expect(countTreeNodes(tree)).toBeLessThanOrEqual(DIR_TREE_MAX_NODES);
  // mdCount 三枝相同 → 自然序 t0/t1 整枝保留(各 701);t2 超剩余预算 → 下钻保留其子目录叶子
  const t0 = tree.find((n) => n.path === 't0/')!;
  const t1 = tree.find((n) => n.path === 't1/')!;
  expect(countTreeNodes([t0])).toBe(701);
  expect(countTreeNodes([t1])).toBe(701);
  const t2 = tree.find((n) => n.path === 't2/')!;
  expect(countTreeNodes([t2])).toBe(DIR_TREE_MAX_NODES - 1402);
  // 保留的 t2 子节点都是完整叶子(无"子目录被砍、父目录残留"的交错缺失)
  for (const child of t2.children) {
    expect(child.children).toHaveLength(0);
  }
});

test('buildDirTree：代码仓库正确提取 codeCount、primaryLang 与 keyFiles', () => {
  const nodes: GitHubNode[] = [
    { path: 'micrograd', type: 'tree' },
    { path: 'micrograd/engine.py', type: 'blob', size: 100 },
    { path: 'micrograd/nn.py', type: 'blob', size: 100 },
    { path: 'micrograd/__init__.py', type: 'blob', size: 100 },
    { path: 'test', type: 'tree' },
    { path: 'test/test_engine.py', type: 'blob', size: 100 },
  ];
  const tree = buildDirTree(nodes);
  const mg = tree.find((n) => n.path === 'micrograd/')!;
  expect(mg).toBeDefined();
  expect(mg.mdCount).toBe(0);
  expect(mg.codeCount).toBe(3);
  expect(mg.primaryLang).toBe('python');
  expect(mg.keyFiles).toEqual(['engine.py', 'nn.py', '__init__.py']);

  const testNode = tree.find((n) => n.path === 'test/')!;
  expect(testNode).toBeDefined();
  expect(testNode.codeCount).toBe(1);
  expect(testNode.primaryLang).toBe('python');
  expect(testNode.keyFiles).toEqual(['test_engine.py']);
});
