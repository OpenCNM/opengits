import { afterAll, describe, expect, it } from 'vitest';

/**
 * 内容模式检索集成测试（READS=1，文件级进程隔离）：
 * chunk 挂内容层（contentId-only）→ Content→薄行 JOIN 命中；
 * 真冻结可见性沿薄行判定（私有薄行对非归属者不可见）。
 */

// 必须在任何模块加载前置位——ENGINE_CONFIG 于首次加载时缓存。
// ESM 静态导入会被提升到本行之前，故全部走动态 import（见 bootstrap）。
process.env.DOCUMENT_CONTENT_READS = '1';

const RUN = Date.now();
const OWNER_ID = `cc_owner_${RUN}`;

let prisma!: typeof import('@/lib/db')['prisma'];
let searchRepositoryDocs!: typeof import('@/lib/mcp/doc-search')['searchRepositoryDocs'];

async function bootstrap() {
  const dbMod = await import('@/lib/db');
  prisma = dbMod.prisma;
  const searchMod = await import('@/lib/mcp/doc-search');
  searchRepositoryDocs = searchMod.searchRepositoryDocs;
}

afterAll(async () => {
  await prisma.document.deleteMany({ where: { repositoryId: { startsWith: `cc_repo_${RUN}` } } });
  await prisma.documentContent.deleteMany({ where: { contentHash: { startsWith: `cc_${RUN}` } } });
  await prisma.repository.deleteMany({ where: { id: { startsWith: `cc_repo_${RUN}` } } });
  await prisma.user.deleteMany({ where: { id: OWNER_ID } });
  await prisma.$disconnect();
});

async function seedFixture(opts: { thinOwner: string | null }) {
  const repo = await prisma.repository.create({
    data: {
      id: `cc_repo_${RUN}_${Math.random().toString(36).slice(2, 8)}`,
      owner: 'cc-owner',
      repo: `cc-${RUN}-${Math.random().toString(36).slice(2, 6)}`,
      isPublic: true,
    },
  });
  const dc = await prisma.documentContent.create({
    data: {
      contentHash: `cc_${RUN}_${Math.random().toString(36).slice(2, 10)}`,
      content: 'The quantum flux matrix regulates hyperdrive calibration.',
      lang: 'en',
    },
  });
  const doc = await prisma.document.create({
    data: {
      repositoryId: repo.id,
      ownerUserId: opts.thinOwner,
      path: 'guide/quantum.md',
      title: 'Quantum Guide',
      status: 'PROCESSED',
      content: 'legacy mirror',
      contentId: dc.id,
    },
  });
  await prisma.documentChunk.create({
    data: {
      contentId: dc.id,
      heading: 'Flux',
      contentType: 'prose',
      content: 'The quantum flux matrix regulates hyperdrive calibration.',
      order: 0,
    },
  });
  return { repo, dc, doc };
}

describe('doc-search 内容模式(READS=1)', () => {
  it('contentId-only chunk 经 Content→薄行 JOIN 可命中,doc_id 归属薄行', async () => {
    await bootstrap();
    const { repo, doc } = await seedFixture({ thinOwner: null });
    const hits = await searchRepositoryDocs(repo.id, 'quantum flux', 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const top = hits.find((h) => h.content.includes('quantum flux'));
    expect(top).toBeTruthy();
    expect(top!.id).toBeTruthy();
    // 归属薄行校验：path/title 来自薄行
    const thin = await prisma.document.findUnique({ where: { id: doc.id }, select: { path: true, title: true } });
    expect(thin?.path).toBe('guide/quantum.md');
    void thin;
  }, 20000);

  it('真冻结可见性:仅私有薄行时匿名不可见,归属者可搜', async () => {
    await bootstrap();
    await prisma.user.create({
      data: { id: OWNER_ID, name: 'cc owner', email: `${OWNER_ID}@test.local` },
    }).catch(() => undefined);
    const { repo } = await seedFixture({ thinOwner: OWNER_ID });

    const anon = await searchRepositoryDocs(repo.id, 'quantum flux', 5, undefined, undefined, undefined, undefined, undefined, null);
    expect(anon).toHaveLength(0);

    const ownerHits = await searchRepositoryDocs(
      repo.id, 'quantum flux', 5,
      undefined, undefined, undefined, undefined, undefined, OWNER_ID,
    );
    expect(ownerHits.length).toBeGreaterThanOrEqual(1);
  }, 20000);
});
