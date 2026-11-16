import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 内容寻址层单测：双哈希（contentHash 规范化稳定 / requestFingerprint 键序无关且敏感）/
 * upsertContentLayer（命中回填指纹 / P2002 竞态回落重查）/ attachContentChunks 字段映射。
 */

const findUniqueMock = vi.fn();
const updateManyMock = vi.fn();
const createMock = vi.fn();
const chunkFindManyMock = vi.fn();
const chunkDeleteManyMock = vi.fn();
const chunkCreateManyMock = vi.fn();
const executeRawMock = vi.fn();

const mockCallSidecar = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => mockCallSidecar(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    $executeRaw: (...args: unknown[]) => executeRawMock(...args),
    documentContent: {
      findUnique: findUniqueMock,
      updateMany: updateManyMock,
      create: createMock,
    },
    documentChunk: {
      findMany: chunkFindManyMock,
      deleteMany: chunkDeleteManyMock,
      createMany: chunkCreateManyMock,
    },
  },
}));

describe('content-addressing(内容寻址层)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function mod() {
    vi.resetModules();
    return import('@/lib/content-addressing');
  }

  it('computeContentHash：CRLF/首尾空白规范化后哈希一致；lang 参与键', async () => {
    const m = await mod();
    const a = m.computeContentHash('# Hi\r\n\r\nBody  \n', 'zh');
    const b = m.computeContentHash('# Hi\n\nBody', 'zh');
    expect(a).toBe(b);
    expect(a).not.toBe(m.computeContentHash('# Hi\n\nBody', 'en'));
  });

  it('requestFingerprint：键书写顺序无关；任一语义字段变化即漂移', async () => {
    const m = await mod();
    const base = { repositoryId: 'r1', path: 'a.md', gitSha: 'sha1', lang: 'zh', model: 'm1' };
    const reordered = { model: 'm1', lang: 'zh', path: 'a.md', gitSha: 'sha1', repositoryId: 'r1' };
    expect(m.computeRequestFingerprint(base)).toBe(m.computeRequestFingerprint(reordered));

    expect(m.computeRequestFingerprint(base)).not.toBe(
      m.computeRequestFingerprint({ ...base, model: 'm2' }),
    );
    expect(m.computeRequestFingerprint(base)).not.toBe(
      m.computeRequestFingerprint({ ...base, lang: 'en' }),
    );
    // 空值字段不参与：显式 null 与省略等价
    expect(m.computeRequestFingerprint({ ...base, preset: null })).toBe(
      m.computeRequestFingerprint(base),
    );
  });

  it('upsertContentLayer：委托给 Go sidecar /v1/cas/content/upsert 返回 contentId', async () => {
    mockCallSidecar.mockResolvedValueOnce({ ok: true, contentId: 'dc_1' });
    const m = await mod();
    const id = await m.upsertContentLayer({
      contentHash: 'h1',
      requestFingerprint: 'fp1',
      content: 'x',
      lang: 'zh',
    });
    expect(id).toBe('dc_1');
    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/cas/content/upsert',
      expect.objectContaining({
        contentHash: 'h1',
        requestFingerprint: 'fp1',
        content: 'x',
        lang: 'zh',
      }),
      expect.anything(),
    );
  });

  it('attachContentChunks：委托给 Go sidecar /v1/cas/chunks/attach 复制切片', async () => {
    mockCallSidecar.mockResolvedValueOnce({ ok: true, count: 2 });
    const m = await mod();
    const n = await m.attachContentChunks('dc_9', 'doc_1');
    expect(n).toBe(2);
    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/cas/chunks/attach',
      { contentId: 'dc_9', documentId: 'doc_1' },
      expect.anything(),
    );
  });

  it('开关读取:零物化收官后双写默认关，显式 DOCUMENT_CONTENT_DUAL_WRITE=1 开启', async () => {
    delete process.env.DOCUMENT_CONTENT_DUAL_WRITE;
    const m = await mod();
    expect(m.isDualWriteEnabled()).toBe(false);
    expect(m.isContentReadsEnabled()).toBe(true); // T2 灰度通过后默认翻 1

    process.env.DOCUMENT_CONTENT_DUAL_WRITE = '1';
    const m2 = await mod();
    expect(m2.isDualWriteEnabled()).toBe(true);
    delete process.env.DOCUMENT_CONTENT_DUAL_WRITE;
  });
});

describe('applyContentLayerRead(正文读取切换)', () => {
  async function modWithReads(enabled: boolean) {
    vi.resetModules();
    process.env.DOCUMENT_CONTENT_READS = enabled ? '1' : '0';
    return import('@/lib/content-addressing');
  }
  afterEach(() => {
    delete process.env.DOCUMENT_CONTENT_READS;
  });

  const baseDoc = {
    id: 'd1',
    contentId: 'dc_1' as string | null,
    content: 'legacy-bytes' as string | null,
    contentRef: { content: 'content-layer-bytes' },
  };

  it('READS 开 + contentId + contentRef 有值 → 覆盖为内容层字节（浅克隆）', async () => {
    const m = await modWithReads(true);
    const out = m.applyContentLayerRead(baseDoc);
    expect(out.content).toBe('content-layer-bytes');
    expect(out).not.toBe(baseDoc); // 不污染调用方对象
  });

  it('READS 关 → 原样返回 legacy 列', async () => {
    const m = await modWithReads(false);
    const out = m.applyContentLayerRead(baseDoc);
    expect(out.content).toBe('legacy-bytes');
    expect(out).toBe(baseDoc); // 同引用零开销
  });

  it('未指内容层(contentId=null)或 contentRef 缺失 → 原样返回', async () => {
    const m = await modWithReads(true);
    const noLink = m.applyContentLayerRead({ ...baseDoc, contentId: null });
    expect(noLink.content).toBe('legacy-bytes');
    const noRef = m.applyContentLayerRead({ ...baseDoc, contentRef: null });
    expect(noRef.content).toBe('legacy-bytes');
  });

  it('contentRef.content 为空串 → 视同缺失，不覆盖 legacy（防御空内容层行）', async () => {
    const m = await modWithReads(true);
    const emptyLayer = m.applyContentLayerRead({ ...baseDoc, contentRef: { content: '' } });
    expect(emptyLayer.content).toBe('legacy-bytes');
  });
});
