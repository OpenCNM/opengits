import { afterAll, describe, expect, it } from 'vitest';

/**
 * Phase 4 T2 灰度回归（READS=1，文件级进程隔离）：
 * 薄行 legacy content 列为空时——
 * ① applyContentLayerRead 取回内容层字节；
 * ② 检索经 Content→薄行 JOIN 命中（T4 路径复验）。
 * 这是 READS 默认值翻 1 的前置证据。
 */

process.env.DOCUMENT_CONTENT_READS = '1';

const RUN = Date.now();
const OWNER_ID = `p4t2_owner_${RUN}`;

let prisma!: typeof import('@/lib/db')['prisma'];
let applyContentLayerRead!: typeof import('@/lib/content-addressing')['applyContentLayerRead'];
let searchRepositoryDocs!: typeof import('@/lib/mcp/doc-search')['searchRepositoryDocs'];

async function bootstrap() {
  const dbMod = await import('@/lib/db');
  prisma = dbMod.prisma;
  const ca = await import('@/lib/content-addressing');
  applyContentLayerRead = ca.applyContentLayerRead;
  const s = await import('@/lib/mcp/doc-search');
  searchRepositoryDocs = s.searchRepositoryDocs;
}

afterAll(async () => {
  await prisma.document.deleteMany({ where: { repositoryId: { startsWith: `p4t2_repo_${RUN}` } } });
  await prisma.documentContent.deleteMany({ where: { id: { startsWith: `p4t2_dc_` } } });
  await prisma.repository.deleteMany({ where: { id: { startsWith: `p4t2_repo_${RUN}` } } });
  await prisma.user.delete({ where: { id: OWNER_ID } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('Phase4-T2 内容层读取灰度(READS=1)', () => {
  it('legacy 列为空的薄行:正文取内容层字节,检索同链路命中', async () => {
    await bootstrap();

    const user = await prisma.user.create({
      data: { id: OWNER_ID, name: 'p4t2', email: `${OWNER_ID}@test.local` },
    });
    void user;
    const repo = await prisma.repository.create({
      data: {
        id: `p4t2_repo_${RUN}_a`,
        owner: 'p4t2-owner',
        repo: `p4t2-${RUN}`,
        isPublic: true,
      },
    });
    const dc = await prisma.documentContent.create({
      data: {
        id: `p4t2_dc_${Math.random().toString(36).slice(2, 10)}`,
        contentHash: `p4t2_${RUN}`,
        content: '# Cutover Chapter\n\nContent-layer bytes only — no legacy mirror.',
        lang: 'en',
      },
    });
    // 关键：薄行 content=null（停写模式的最终形态）
    const doc = await prisma.document.create({
      data: {
        repositoryId: repo.id,
        path: 'cutover.md',
        title: 'Cutover',
        status: 'PROCESSED',
        content: null,
        contentId: dc.id,
      },
    });
    await prisma.documentChunk.create({
      data: {
        contentId: dc.id,
        heading: 'Cutover',
        contentType: 'prose',
        content: 'Content-layer bytes only — no legacy mirror.',
        order: 0,
      },
    });

    // ① 正文：helper 覆盖生效
    const row = await prisma.document.findUnique({
      where: { id: doc.id },
      include: { contentRef: { select: { content: true } } },
    });
    const effective = applyContentLayerRead(row!);
    expect(effective.content).toContain('no legacy mirror');

    // ② 检索：Content→薄行 JOIN 复验
    const hits = await searchRepositoryDocs(repo.id, 'cutover chapter', 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].content).toContain('no legacy mirror');
  }, 20000);
});
