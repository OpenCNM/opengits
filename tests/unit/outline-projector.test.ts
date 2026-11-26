import { describe, it, expect, vi } from 'vitest';
import {
  projectNavTreeFromOutline,
  resolveEffectiveNavTree,
  getEffectiveNavTree,
  syncRepositoryNavTreeFromOutline,
} from '@/lib/mcp/outline-projector';
import type { OutlineView } from '@/lib/outline-reader';

describe('outline-projector: 大纲 ➔ NavTree 单向确定性投影', () => {
  const repoInfo = { owner: 'acme', repo: 'super-app' };

  it('1. 单节点扁平化：章节仅有 1 节且与章同名时扁平化为 file 节点', () => {
    const outline: OutlineView = {
      outlineId: 'o-1',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [
        {
          id: 'c-1',
          title: '起步入门',
          summary: '介绍与快速入门',
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-1',
              title: '起步入门',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-1',
              docPath: 'guide/getting-started.mdx',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = projectNavTreeFromOutline(outline, repoInfo);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toEqual({
      name: 'getting-started.mdx',
      title: '起步入门',
      type: 'file',
      path: 'guide/getting-started.mdx',
      url: '/docs/acme/super-app/guide/getting-started',
    });
  });

  it('2. 目录型章节：单节点但标题不同时，以及多节点时，保留为 directory 节点', () => {
    const outline: OutlineView = {
      outlineId: 'o-2',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [
        {
          id: 'c-diff',
          title: '存储引擎',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-diff',
              title: 'LSM-Tree 核心实现',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-1',
              docPath: 'storage/lsm.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
        {
          id: 'c-multi',
          title: '网络通信',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 2,
          nodes: [
            {
              id: 'n-2a',
              title: 'TCP 协议栈',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-2a',
              docPath: 'net/tcp.md',
              docStatus: 'PROCESSED',
            },
            {
              id: 'n-2b',
              title: 'HTTP/3 协议栈',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-2b',
              docPath: 'net/http3.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = projectNavTreeFromOutline(outline, repoInfo);
    expect(tree).toHaveLength(2);

    // 单节但标题不同：保留目录包装
    expect(tree[0]).toEqual({
      name: '存储引擎',
      title: '存储引擎',
      type: 'directory',
      path: '',
      url: '',
      children: [
        {
          name: 'lsm.md',
          title: 'LSM-Tree 核心实现',
          type: 'file',
          path: 'storage/lsm.md',
          url: '/docs/acme/super-app/storage/lsm',
        },
      ],
    });

    // 多节：保持目录结构
    expect(tree[1]).toEqual({
      name: '网络通信',
      title: '网络通信',
      type: 'directory',
      path: '',
      url: '',
      children: [
        {
          name: 'tcp.md',
          title: 'TCP 协议栈',
          type: 'file',
          path: 'net/tcp.md',
          url: '/docs/acme/super-app/net/tcp',
        },
        {
          name: 'http3.md',
          title: 'HTTP/3 协议栈',
          type: 'file',
          path: 'net/http3.md',
          url: '/docs/acme/super-app/net/http3',
        },
      ],
    });
  });

  it('3. 嵌套大类（parts）与平铺章节正确组装', () => {
    const outline: OutlineView = {
      outlineId: 'o-3',
      version: 1,
      mode: 'tutorial',
      parts: [
        {
          id: 'p-1',
          title: '第一卷：基础理论',
          summary: '理论知识体系',
          teachingOrder: 2,
          chapters: [
            {
              id: 'c-p1',
              title: '算法复杂度',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 1,
              nodes: [
                {
                  id: 'n-p1',
                  title: '算法复杂度',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-p1',
                  docPath: 'theory/complexity.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
      ],
      chapters: [
        {
          id: 'c-top',
          title: '全书前言',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-top',
              title: '全书前言',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-top',
              docPath: 'preface.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = projectNavTreeFromOutline(outline, repoInfo);
    expect(tree).toHaveLength(2);

    // teachingOrder 1 的前言在前
    expect(tree[0].title).toBe('全书前言');
    expect(tree[0].type).toBe('file');
    expect(tree[0].path).toBe('preface.md');

    // teachingOrder 2 的大类在后，且为 directory 节点
    expect(tree[1].title).toBe('第一卷：基础理论');
    expect(tree[1].type).toBe('directory');
    expect(tree[1].children).toHaveLength(1);
    expect(tree[1].children?.[0].title).toBe('算法复杂度');
  });

  it('4. Overview 节点与 URL/Title 规约验证', () => {
    const outline: OutlineView = {
      outlineId: 'o-4',
      version: 1,
      mode: 'explorer',
      parts: [],
      chapters: [
        {
          id: 'c-custom',
          title: '从文档读取的标题',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-md',
              title: '', // title 缺省，回退到 document.title
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-md',
              docPath: 'docs/test-file.mdx',
              docStatus: 'PROCESSED',
              document: { title: '从文档读取的标题' },
            } as any,
          ],
        },
      ],
    };

    const tree = projectNavTreeFromOutline(outline, repoInfo);
    // explorer 概览节点已随巨型泳道退役:大纲章直出
    expect(tree).toHaveLength(1);
    expect(tree[0]).toEqual({
      name: 'test-file.mdx',
      title: '从文档读取的标题',
      type: 'file',
      path: 'docs/test-file.mdx',
      url: '/docs/acme/super-app/docs/test-file',
    });
  });

  it('5. 边界防御：无 docPath 节点跳过，空章不入树，空输入安全返回', () => {
    expect(projectNavTreeFromOutline(null as any, repoInfo)).toEqual([]);
    expect(projectNavTreeFromOutline(undefined as any, repoInfo)).toEqual([]);

    const emptyOutline: OutlineView = {
      outlineId: 'o-empty',
      version: 1,
      mode: 'tutorial',
      parts: [
        {
          id: 'p-empty',
          title: '空大类',
          summary: null,
          teachingOrder: 1,
          chapters: [],
        },
      ],
      chapters: [
        {
          id: 'c-no-doc',
          title: '未关联文档的空章',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 2,
          nodes: [
            {
              id: 'n-null',
              title: '草案节',
              nodeType: 'doc',
              headingPath: null,
              documentId: null,
              docPath: null,
              docStatus: null,
            },
          ],
        },
      ],
    };

    const tree = projectNavTreeFromOutline(emptyOutline, repoInfo);
    expect(tree).toEqual([]);
  });

  it('6. 大类与平铺章节混排保序：根层文件与目录交错时严格按 teachingOrder 保序（向量 1.11.4.1）', () => {
    // 模拟根层结构: 文件(序1) ➔ 大类(序2,内含序2节) ➔ 文件(序3)
    const mixedOutline: OutlineView = {
      outlineId: 'o-mixed',
      version: 1,
      mode: 'tutorial',
      parts: [
        {
          id: 'p-guide',
          title: '开发指南',
          summary: null,
          teachingOrder: 2,
          chapters: [
            {
              id: 'c-intro',
              title: '开发指南',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 2,
              nodes: [
                {
                  id: 'n-intro',
                  title: '开发指南',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-intro',
                  docPath: 'guide/intro.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
      ],
      chapters: [
        {
          id: 'c-welcome',
          title: '欢迎页',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-welcome',
              title: '欢迎页',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-welcome',
              docPath: 'welcome.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
        {
          id: 'c-faq',
          title: '常见问题',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 3,
          nodes: [
            {
              id: 'n-faq',
              title: '常见问题',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-faq',
              docPath: 'faq.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = projectNavTreeFromOutline(mixedOutline, repoInfo);
    expect(tree).toHaveLength(3);
    expect(tree[0].title).toBe('欢迎页');
    expect(tree[1].title).toBe('开发指南');
    expect(tree[2].title).toBe('常见问题');
  });

  it('1.11.4.1 大纲二阶段单向确定性投影与排序决胜：同 teachingOrder 时按 subOrder 稳定决胜', () => {
    const outlineWithTie: OutlineView = {
      outlineId: 'o-tie',
      version: 1,
      mode: 'tutorial',
      parts: [
        {
          id: 'p-tie',
          title: '进阶主题',
          summary: null,
          teachingOrder: 1,
          chapters: [
            {
              id: 'c-sub',
              title: '进阶主题',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 2,
              nodes: [
                {
                  id: 'n-sub',
                  title: '进阶主题',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-sub',
                  docPath: 'advanced.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
      ],
      chapters: [
        {
          id: 'c-tie-top',
          title: '基础快速起步',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-quick',
              title: '基础快速起步',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-quick',
              docPath: 'quickstart.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = projectNavTreeFromOutline(outlineWithTie, repoInfo);
    expect(tree).toHaveLength(2);
    // c-tie-top subOrder 为 1，p-tie subOrder 为 2 -> 基础快速起步在进阶主题之前
    expect(tree[0].title).toBe('基础快速起步');
    expect(tree[1].title).toBe('进阶主题');
  });

  it('1.11.4.1 大纲二阶段单向确定性投影与排序决胜：同 teachingOrder 且同 subOrder 时按标题字典序稳定决胜', () => {
    const outlineWithExactTie: OutlineView = {
      outlineId: 'o-exact-tie',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [
        {
          id: 'c-z',
          title: 'Zebra 章节',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-z',
              title: 'Zebra 章节',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-z',
              docPath: 'zebra.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
        {
          id: 'c-a',
          title: 'Apple 章节',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-a',
              title: 'Apple 章节',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-a',
              docPath: 'apple.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = projectNavTreeFromOutline(outlineWithExactTie, repoInfo);
    expect(tree).toHaveLength(2);
    // 尽管 Zebra 放在数组前部，但两者 order 均为 1，标题字典序决胜确保 Apple 在 Zebra 之前
    expect(tree[0].title).toBe('Apple 章节');
    expect(tree[1].title).toBe('Zebra 章节');
  });

  it('7. Overview 节点去重：大纲中同时具备概览与指向概览的章节时绝不重复入树', () => {
    const outlineWithDuplicate: OutlineView = {
      outlineId: 'o-dup',
      version: 1,
      mode: 'explorer',
      parts: [],
      chapters: [
        {
          id: 'c-dup-arch',
          title: 'Architecture Overview',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-dup-arch',
              title: 'Architecture Overview',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-arch',
              docPath: 'architecture-overview',
              docStatus: 'PROCESSED',
            },
          ],
        },
        {
          id: 'c-real-doc',
          title: '快速起步',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 2,
          nodes: [
            {
              id: 'n-real-doc',
              title: '快速起步',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-real',
              docPath: 'quickstart.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = projectNavTreeFromOutline(outlineWithDuplicate, repoInfo);
    expect(tree).toHaveLength(2);
    expect(tree[0].name).toBe('architecture-overview');
    expect(tree[0].path).toBe('architecture-overview');
    expect(tree[1].title).toBe('快速起步');
    expect(tree[1].path).toBe('quickstart.md');
  });

  it('8. URL slug 规范化防御：带有前导斜杠的 docPath 不产生双斜杠 URL', () => {
    const outlineWithSlash: OutlineView = {
      outlineId: 'o-slash',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [
        {
          id: 'c-slash',
          title: '斜杠测试',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-slash',
              title: '斜杠测试',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-slash',
              docPath: '/docs/deep/nested.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = projectNavTreeFromOutline(outlineWithSlash, repoInfo);
    expect(tree).toHaveLength(1);
    expect(tree[0].url).toBe('/docs/acme/super-app/docs/deep/nested');
    expect(tree[0].url).not.toContain('//docs');
  });

  it('9. Round-Trip 确定性：navTree ➔ outlineFromNavTree ➔ projectNavTreeFromOutline 顺序结构 100% 保持', async () => {
    const { outlineFromNavTree } = await import('@/lib/mcp/outline-derive');

    const originalTree = [
      { name: 'welcome.md', title: '欢迎页', type: 'file' as const, path: 'welcome.md', url: '/docs/acme/super-app/welcome' },
      {
        name: 'guide',
        title: '开发指南',
        type: 'directory' as const,
        path: '',
        url: '',
        children: [
          { name: 'intro.md', title: '快速入门', type: 'file' as const, path: 'guide/intro.md', url: '/docs/acme/super-app/guide/intro' },
        ],
      },
      { name: 'faq.md', title: '常见问题', type: 'file' as const, path: 'faq.md', url: '/docs/acme/super-app/faq' },
    ];

    const draft = outlineFromNavTree(originalTree as any);
    const view: OutlineView = {
      outlineId: 'o-roundtrip',
      version: 1,
      mode: 'tutorial',
      parts: draft.parts.map((p) => ({
        id: 'p-' + p.title,
        title: p.title,
        summary: null,
        teachingOrder: p.teachingOrder,
        chapters: draft.chapters
          .filter((c) => c.partTitle === p.title)
          .map((c) => ({
            id: 'c-' + c.title,
            title: c.title,
            summary: null,
            chapterType: c.chapterType,
            moduleName: null,
            teachingOrder: c.teachingOrder,
            nodes: c.nodes.map((n) => ({
              id: 'n-' + n.sourcePath,
              title: n.title,
              nodeType: n.nodeType,
              headingPath: null,
              documentId: 'doc-' + n.sourcePath,
              docPath: n.sourcePath,
              docStatus: 'PROCESSED' as const,
            })),
          })),
      })),
      chapters: draft.chapters
        .filter((c) => !c.partTitle)
        .map((c) => ({
          id: 'c-' + c.title,
          title: c.title,
          summary: null,
          chapterType: c.chapterType,
          moduleName: null,
          teachingOrder: c.teachingOrder,
          nodes: c.nodes.map((n) => ({
            id: 'n-' + n.sourcePath,
            title: n.title,
            nodeType: n.nodeType,
            headingPath: null,
            documentId: 'doc-' + n.sourcePath,
            docPath: n.sourcePath,
            docStatus: 'PROCESSED' as const,
          })),
        })),
      moduleMapEntries: [],
    };

    const projectedTree = projectNavTreeFromOutline(view, repoInfo);
    expect(projectedTree.map((n) => n.title)).toEqual(originalTree.map((n) => n.title));
    expect(projectedTree[0].type).toBe('file');
    expect(projectedTree[1].type).toBe('directory');
    expect(projectedTree[2].type).toBe('file');
  });

  describe('10. getEffectiveNavTree & syncRepositoryNavTreeFromOutline 零物化读写解耦', () => {
    it('命中激活大纲时，纯函数实时投影且绝不调用 repository.update 写盘', async () => {
      const mockRepoId = 'repo-test-outline';
      const mockTx: any = {
        repository: {
          findUnique: vi.fn().mockResolvedValue({
            id: mockRepoId,
            owner: 'test-owner',
            repo: 'test-repo',
          }),
          update: vi.fn(),
        },
        document: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        tutorialOutline: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'outline-active-1',
            repositoryId: mockRepoId,
            isActive: true,
            chapters: [
              {
                id: 'ch-1',
                title: '入门指南',
                teachingOrder: 1,
                nodes: [
                  {
                    id: 'n-1',
                    title: '入门指南',
                    teachingOrder: 1,
                    document: {
                      id: 'd-1',
                      path: 'intro.md',
                      title: '入门指南',
                    },
                  },
                ],
              },
            ],
          }),
        },
      };

      const result = await getEffectiveNavTree(mockRepoId, {
        owner: 'test-owner',
        repo: 'test-repo',
        tx: mockTx,
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'intro.md',
        title: '入门指南',
        type: 'file',
        path: 'intro.md',
        url: '/docs/test-owner/test-repo/intro',
      });
      // 零物化：绝不写入 repository.update
      expect(mockTx.repository.update).not.toHaveBeenCalled();
    });

    it('冷旧仓无激活大纲时，正确回退到 fallbackNavTree 且零写盘', async () => {
      const mockRepoId = 'repo-test-cold';
      const mockTx: any = {
        repository: {
          findUnique: vi.fn().mockResolvedValue({
            id: mockRepoId,
            owner: 'cold-owner',
            repo: 'cold-repo',
            navTree: [{ name: 'cold.md', title: '冷旧文档', type: 'file', path: 'cold.md', url: '/docs/cold-owner/cold-repo/cold' }],
          }),
          update: vi.fn(),
        },
        document: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        tutorialOutline: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      // 1. 显式传入 fallbackNavTree
      const explicitFallback = [
        { name: 'fallback.md', title: '回退文档', type: 'file' as const, path: 'fallback.md', url: '/docs/cold-owner/cold-repo/fallback' },
      ];
      const result1 = await getEffectiveNavTree(mockRepoId, {
        owner: 'cold-owner',
        repo: 'cold-repo',
        tx: mockTx,
        fallbackNavTree: explicitFallback,
      });
      expect(result1).toEqual(explicitFallback);
      expect(mockTx.repository.update).not.toHaveBeenCalled();

      // 2. 未传 fallbackNavTree 时自动回退 DB 中的 repository.navTree
      const result2 = await getEffectiveNavTree(mockRepoId, {
        owner: 'cold-owner',
        repo: 'cold-repo',
        tx: mockTx,
      });
      expect(result2).toEqual([
        { name: 'cold.md', title: '冷旧文档', type: 'file', path: 'cold.md', url: '/docs/cold-owner/cold-repo/cold' },
      ]);
      expect(mockTx.repository.update).not.toHaveBeenCalled();
    });

    it('syncRepositoryNavTreeFromOutline 保持方法兼容性并彻底停写 repository.navTree', async () => {
      const mockRepoId = 'repo-sync-compat';
      const mockTx: any = {
        repository: {
          findUnique: vi.fn().mockResolvedValue({
            id: mockRepoId,
            owner: 'owner-compat',
            repo: 'repo-compat',
          }),
          update: vi.fn(),
        },
        document: {
          findFirst: vi.fn().mockResolvedValue({
            title: 'Overview',
            path: 'architecture-overview',
          }),
        },
        tutorialOutline: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      const tree = await syncRepositoryNavTreeFromOutline(mockRepoId, mockTx);
      // 概览单节点兜底已随巨型泳道退役:无大纲 → 空投影
      expect(tree).toHaveLength(0);
      // 零物化：确保 update 绝不调用
      expect(mockTx.repository.update).not.toHaveBeenCalled();
    });

    it('冷旧仓存在 overviewDoc 时，fallbackNavTree 的多章节绝不被冲刷丢失（防数据丢失断言）', async () => {
      const mockRepoId = 'repo-cold-with-overview-and-chapters';
      const mockTx: any = {
        repository: {
          findUnique: vi.fn().mockResolvedValue({
            id: mockRepoId,
            owner: 'owner-1',
            repo: 'repo-1',
            navTree: [
              { name: '01.md', title: '第1章', type: 'file', path: '01.md', url: '/docs/owner-1/repo-1/01' },
              { name: '02.md', title: '第2章', type: 'file', path: '02.md', url: '/docs/owner-1/repo-1/02' },
            ],
          }),
          update: vi.fn(),
        },
        document: {
          findFirst: vi.fn().mockResolvedValue({
            title: '架构概览',
            path: 'architecture-overview',
          }),
        },
        tutorialOutline: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      // 1. 传入显式 fallbackNavTree 时，优先使用 fallbackNavTree，绝不被 overviewDoc 覆盖冲刷
      const explicitFallback = [
        { name: 'custom-1.md', title: '自定义1', type: 'file' as const, path: 'custom-1.md', url: '/docs/owner-1/repo-1/custom-1' },
        { name: 'custom-2.md', title: '自定义2', type: 'file' as const, path: 'custom-2.md', url: '/docs/owner-1/repo-1/custom-2' },
      ];
      const res1 = await getEffectiveNavTree(mockRepoId, {
        owner: 'owner-1',
        repo: 'repo-1',
        tx: mockTx,
        fallbackNavTree: explicitFallback,
      });
      expect(res1).toHaveLength(2);
      expect(res1).toEqual(explicitFallback);
      expect(mockTx.repository.update).not.toHaveBeenCalled();

      // 2. 未传 fallbackNavTree 时，自动回退 DB 中的 navTree，依然绝不被 overviewDoc 冲刷丢失
      const res2 = await getEffectiveNavTree(mockRepoId, {
        owner: 'owner-1',
        repo: 'repo-1',
        tx: mockTx,
      });
      expect(res2).toHaveLength(2);
      expect(res2[0].name).toBe('01.md');
      expect(res2[1].name).toBe('02.md');
      expect(mockTx.repository.update).not.toHaveBeenCalled();

      // 3. syncRepositoryNavTreeFromOutline 同样行为一致
      const res3 = await syncRepositoryNavTreeFromOutline(mockRepoId, mockTx, {
        owner: 'owner-1',
        repo: 'repo-1',
        fallbackNavTree: explicitFallback,
      });
      expect(res3).toHaveLength(2);
      expect(res3).toEqual(explicitFallback);
    });

    it('冷旧仓既无大纲也无任何章节时，若存在 overviewDoc，平滑回退概览单节点', async () => {
      const mockRepoId = 'repo-cold-empty-chapters';
      const mockTx: any = {
        repository: {
          findUnique: vi.fn().mockResolvedValue({
            id: mockRepoId,
            owner: 'owner-empty',
            repo: 'repo-empty',
            navTree: [],
          }),
          update: vi.fn(),
        },
        document: {
          findFirst: vi.fn().mockResolvedValue({
            title: '架构概览',
            path: 'architecture-overview',
          }),
        },
        tutorialOutline: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      const res = await getEffectiveNavTree(mockRepoId, {
        owner: 'owner-empty',
        repo: 'repo-empty',
        tx: mockTx,
        fallbackNavTree: [],
      });
      // 概览单节点兜底已随巨型泳道退役:空大纲空树 → 空投影
      expect(res).toHaveLength(0);
    });
  });

  describe('11. resolveEffectiveNavTree 纯函数直接投影与零物化全工况测试 (1.11.4.2 / 1.11.4.3)', () => {
    it('🧪 [1.11.4.2] 传入预载 outline 时，纯函数直接投影且 0 数据库查询', async () => {
      const preloadOutline: OutlineView = {
        outlineId: 'outline-preload-1',
        version: 1,
        mode: 'tutorial',
        parts: [],
        chapters: [
          {
            id: 'c-preload',
            title: '预载章节',
            summary: '预载摘要',
            chapterType: 'doc',
            teachingOrder: 1,
            nodes: [
              {
                id: 'n-preload',
                title: '预载章节',
                nodeType: 'doc',
                headingPath: null,
                documentId: 'd-preload',
                docPath: 'guide/preload.md',
                docStatus: 'PROCESSED',
              },
            ],
          },
        ],
      };

      const mockTx: any = {
        repository: {
          findUnique: vi.fn(),
          update: vi.fn(),
        },
        tutorialOutline: {
          findFirst: vi.fn(),
        },
        document: {
          findFirst: vi.fn(),
        },
      };

      const res = await resolveEffectiveNavTree('repo-preload', {
        owner: 'fast-owner',
        repo: 'fast-repo',
        outline: preloadOutline,
        tx: mockTx,
      });

      expect(res).toHaveLength(1);
      expect(res[0]).toEqual({
        name: 'preload.md',
        title: '预载章节',
        type: 'file',
        path: 'guide/preload.md',
        url: '/docs/fast-owner/fast-repo/guide/preload',
      });

      // 零 DB 查询断言：传入预载 outline 时，绝不触碰数据库
      expect(mockTx.repository.findUnique).not.toHaveBeenCalled();
      expect(mockTx.tutorialOutline.findFirst).not.toHaveBeenCalled();
      expect(mockTx.document.findFirst).not.toHaveBeenCalled();
      expect(mockTx.repository.update).not.toHaveBeenCalled();
    });

    it('🧪 [1.11.4.2] 传入预载 outline: null 时，安全跳过大纲查询并走 fallback 逻辑', async () => {
      const mockTx: any = {
        repository: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'repo-null-outline',
            owner: 'cold-owner',
            repo: 'cold-repo',
            navTree: [
              { name: 'doc1.md', title: '文档1', type: 'file', path: 'doc1.md', url: '/docs/cold-owner/cold-repo/doc1' },
            ],
          }),
          update: vi.fn(),
        },
        tutorialOutline: {
          findFirst: vi.fn(),
        },
        document: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      const res = await resolveEffectiveNavTree('repo-null-outline', {
        owner: 'cold-owner',
        repo: 'cold-repo',
        outline: null,
        tx: mockTx,
      });

      expect(res).toHaveLength(1);
      expect(res[0].name).toBe('doc1.md');
      // outline 已明确为 null，绝不调用 tutorialOutline.findFirst
      expect(mockTx.tutorialOutline.findFirst).not.toHaveBeenCalled();
      expect(mockTx.repository.update).not.toHaveBeenCalled();
    });

    it('🧪 [1.11.4.3] 未传 outline 时自动按版本降序查询激活大纲并完成投影', async () => {
      const mockTx: any = {
        repository: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'repo-db-outline',
            owner: 'db-owner',
            repo: 'db-repo',
          }),
          update: vi.fn(),
        },
        document: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        tutorialOutline: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'outline-db-1',
            repositoryId: 'repo-db-outline',
            version: 3,
            isActive: true,
            chapters: [
              {
                id: 'ch-db-1',
                title: '数据库激活章',
                teachingOrder: 1,
                nodes: [
                  {
                    id: 'node-db-1',
                    title: '数据库激活章',
                    teachingOrder: 1,
                    document: { id: 'doc-db-1', path: 'db-doc.md', title: '数据库激活章' },
                  },
                ],
              },
            ],
          }),
        },
      };

      const res = await resolveEffectiveNavTree('repo-db-outline', {
        owner: 'db-owner',
        repo: 'db-repo',
        tx: mockTx,
      });

      expect(res).toHaveLength(1);
      expect(res[0].name).toBe('db-doc.md');
      expect(mockTx.tutorialOutline.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { repositoryId: 'repo-db-outline', isActive: true },
          orderBy: { version: 'desc' },
        })
      );
      expect(mockTx.repository.update).not.toHaveBeenCalled();
    });

    it('冷旧仓无激活大纲且 navTree 为 null 时返回空投影(概览兜底已退役)', async () => {
      const mockTx: any = {
        repository: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'repo-overview-only',
            owner: 'cold-owner',
            repo: 'cold-repo',
            navTree: null,
          }),
          update: vi.fn(),
        },
        tutorialOutline: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      const res = await resolveEffectiveNavTree('repo-overview-only', {
        owner: 'cold-owner',
        repo: 'cold-repo',
        tx: mockTx,
      });

      // 概览单节点兜底已随巨型泳道退役:无大纲无树 → 空(由上层引导重建)
      expect(res).toHaveLength(0);
    });

    it('完全空仓（无大纲、navTree 为 null、无概览文档）时安全返回空数组 []', async () => {
      const mockTx: any = {
        repository: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'repo-completely-empty',
            owner: 'empty-owner',
            repo: 'empty-repo',
            navTree: null,
          }),
          update: vi.fn(),
        },
        tutorialOutline: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        document: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      const res = await resolveEffectiveNavTree('repo-completely-empty', {
        owner: 'empty-owner',
        repo: 'empty-repo',
        tx: mockTx,
      });

      expect(res).toEqual([]);
      expect(mockTx.repository.update).not.toHaveBeenCalled();
    });

    it('向后兼容别名 getEffectiveNavTree 与 resolveEffectiveNavTree 保持完全等价引用', () => {
      expect(getEffectiveNavTree).toBe(resolveEffectiveNavTree);
    });
  });
});
