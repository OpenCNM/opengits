import { test, expect, afterAll } from 'vitest';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { locateRepositorySections, buildLocatorSnippet } from '@/lib/mcp/doc-search';
import { buildSectionAddress, parseSectionAddress } from '@/lib/mcp/section-address';
import { createRepositoryMcpServer } from '@/lib/mcp/server';
import { ENGINE_CONFIG } from '@/lib/config';

const testOwner = `locator-owner-${Date.now()}`;
const testRepo = `locator-repo-${Date.now()}`;
let repoId = '';

afterAll(async () => {
  if (repoId) {
    await prisma.repository.delete({ where: { id: repoId } }).catch(() => {});
    await (prisma as any).episodicEvent.deleteMany({ where: { pageUrl: `mcp://repo/${repoId}` } }).catch(() => {});
  }
});

test('Section address 构建与解析 round-trip', () => {
  const address = buildSectionAddress('docs/getting-started.md', 'core > overview');
  expect(address).toBe('docs/getting-started.md#core > overview');
  const parsed = parseSectionAddress(address);
  expect(parsed.docPath).toBe('docs/getting-started.md');
  expect(parsed.headingPath).toBe('core > overview');
  expect(parseSectionAddress('docs/a.md').headingPath).toBe('');
});

test('Locator 检索真实临时仓：CJK 命中 + 紧凑 snippet', async () => {
  const repoRecord = await prisma.repository.create({
    data: { owner: testOwner, repo: testRepo, branch: ENGINE_CONFIG.defaultBranch, semVerLabel: '1.0.0', isPublic: true, category: 'Testing' },
  });
  repoId = repoRecord.id;
  const docRecord = await prisma.document.create({
    data: {
      repositoryId: repoRecord.id,
      path: 'chapters/context-arch.md',
      title: '上下文架构',
      content: '# 上下文架构\n\n本章讲解多 Agent 系统的上下文架构设计。',
      status: 'PROCESSED',
    },
  });
  // chunker 死岛已摘除（Go chunks_store 单写者）：种子直连 Go /v1/chunks/store，
  // payload 形状逐字取自原 chunker.ts:147-163
  await callSidecar(
    '/v1/chunks/store',
    {
      documentId: docRecord.id,
      docPath: 'chapters/context-arch.md',
      blueprintRole: '',
      semVerLabel: '1.0.0',
      chunks: [
        {
          heading: '多 Agent 系统的上下文架构设计原则',
          // 复刻 Go chunker markdown.go 的 headingPath 语义：heading stack 以 " > " 连接
          headingPath: '多 Agent 系统的上下文架构设计原则',
          contentType: 'markdown',
          content: '## 多 Agent 系统的上下文架构设计原则\n\n在共享工作区中，Agent 间的上下文架构决定了协作效率：子 Agent 需要精确的上下文隔离，而共享产物通过文件系统交换。',
          order: 0,
        },
      ],
    },
    { label: 'locator-reader seed chunks' },
  );

  const query = '上下文架构';
  const hits = await locateRepositorySections(repoRecord.id, query, 10, undefined, undefined, undefined, query);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].id).toBeTruthy();
  expect(hits[0].path).toBe('chapters/context-arch.md');
  expect(hits[0].snippet!.length).toBeGreaterThan(0);
  expect(hits[0].snippet!.length).toBeLessThan(300);
  expect(buildLocatorSnippet('abcdef', ['zzz', 'cd'])).toContain('cd');

  // search locator 输出格式（工具文本含结构化 Address/Snippet 标记——
  // 格式契约由 gen:parity-goldens (target: mcp) 黄金对拍锁定；此处断言标记存在性）
  const server = await createRepositoryMcpServer(testOwner, testRepo, ENGINE_CONFIG.defaultBranch);
  const tools = (server as any)._registeredTools || {};
  const searchRes = await tools['search'].handler({ query }, {});
  const searchText = searchRes?.content?.[0]?.text || '';
  expect(searchText).toContain('Address:');
  expect(searchText).toContain('Snippet:');

  // read (section) 读回完整章节（address 由 locator 结构化结果确定性构造）
  const address = buildSectionAddress(hits[0].path, hits[0].headingPath);
  const readRes = await tools['read'].handler({ target: address }, {});
  const readText = readRes?.content?.[0]?.text || '';
  expect(readText).toContain('上下文隔离');
  expect(readText).toContain('Source Path:');
  const missing = await tools['read'].handler({ target: 'chapters/nope.md#x' }, {});
  expect((missing as any).isError).toBe(true);
});
