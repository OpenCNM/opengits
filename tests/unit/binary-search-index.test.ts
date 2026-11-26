import { describe, expect, it, beforeEach } from 'vitest';
import { packSearchIndex, unpackSearchIndex, OGIS_MAGIC, OGIS_VERSION, type RawChunkRecord } from '@/lib/search/binary-index-packer';
import { tokenizeSearchText } from '@/lib/search/binary-index-service';
import { BinarySearchEngine, getOrLoadSearchEngine, clearSearchEngineCache, slugify } from '@/lib/wasm/binary-search-engine';

describe('binary-index-packer & BinarySearchEngine', () => {
  const sampleChunks: RawChunkRecord[] = [
    {
      id: 'chk-1',
      docPath: 'guide/getting-started.mdx',
      title: 'Getting Started Guide',
      heading: 'Installation',
      headingPath: 'Getting Started > Installation',
      content: 'Run npm install opengits-cli to configure the client repository.',
      tokens: ['getting', 'started', 'guide', 'installation', 'run', 'npm', 'install', 'opengits', 'cli', 'configure', 'client', 'repository'],
    },
    {
      id: 'chk-2',
      docPath: 'guide/getting-started.mdx',
      title: 'Getting Started Guide',
      heading: 'Quick Start',
      headingPath: 'Getting Started > Quick Start',
      content: 'Initialize your project with npx opengits init for instant WASM acceleration.',
      tokens: ['getting', 'started', 'guide', 'quick', 'start', 'initialize', 'project', 'npx', 'opengits', 'init', 'instant', 'wasm', 'acceleration'],
    },
    {
      id: 'chk-3',
      docPath: 'architecture/storage.mdx',
      title: 'Storage Architecture',
      heading: 'MinIO Integration',
      headingPath: 'Architecture > MinIO Integration',
      content: 'MinIO S3 object storage driver serves compact binary search index files.',
      tokens: ['storage', 'architecture', 'minio', 'integration', 's3', 'object', 'driver', 'serves', 'compact', 'binary', 'search', 'index', 'files'],
    },
    {
      id: 'chk-4',
      docPath: 'guide/cjk.mdx',
      title: '中文文档测试',
      heading: '全文检索加速',
      headingPath: '中文文档 > 全文检索',
      content: '基于 WebAssembly 内存索引在浏览器端实现微秒级搜索与高亮展示。',
      tokens: tokenizeSearchText('中文文档测试 全文检索加速 基于 WebAssembly 内存索引在浏览器端实现微秒级搜索与高亮展示。'),
    },
  ];

  let packedBuffer: Buffer;
  let engine: BinarySearchEngine;

  beforeEach(() => {
    clearSearchEngineCache();
    packedBuffer = packSearchIndex(
      { owner: 'facebook', repo: 'react', gitSha: '9f8e7d6c5b4a32101234567890abcdef12345678', chunks: sampleChunks },
      true
    );
    engine = new BinarySearchEngine(unpackSearchIndex(packedBuffer));
  });

  it('OGIS v1 pack/unpack 无损往返、BM25 IDF 与分词', () => {
    const snapshot = unpackSearchIndex(packedBuffer);
    expect([snapshot.magic, snapshot.version, snapshot.owner, snapshot.repo, snapshot.chunks.length]).toEqual([
      OGIS_MAGIC,
      OGIS_VERSION,
      'facebook',
      'react',
      4,
    ]);
    expect(snapshot.chunks[0].snippet).toContain('npm install opengits-cli');
    expect(snapshot.chunks[3].title).toBe('中文文档测试');
    expect(snapshot.terms.get('minio')!.idf).toBeGreaterThan(snapshot.terms.get('opengits')!.idf);

    const tokens = tokenizeSearchText('getOrLoadSearchEngine uses minio_storage for 实时全文检索');
    for (const expected of ['getorloadsearchengine', 'load', 'search', 'engine', 'minio', 'storage', '实', '时', '全', '文', '检', '索']) {
      expect(tokens).toContain(expected);
    }

    expect(() => unpackSearchIndex(Buffer.from('NOT_AN_OGIS_FILE_HEADER_1234567890'))).toThrowError(/Invalid search index/);
  });

  it('精确/前缀/标题加权/CJK/空查询检索与紧凑模式零漂移对拍', () => {
    const compactEngine = new BinarySearchEngine(packedBuffer);
    expect([compactEngine.chunkCount, compactEngine.owner, compactEngine.repo]).toEqual([4, 'facebook', 'react']);

    expect(engine.search('opengits')[0].score).toBeGreaterThan(0);
    expect(engine.search('min')[0].id).toBe('chk-3');
    expect(engine.search('Storage')[0].id).toBe('chk-3');
    expect(engine.search('全文检索')[0].id).toBe('chk-4');
    expect(engine.search('')).toEqual([]);
    expect(engine.search('!@#$%')).toEqual([]);

    for (const q of ['opengits', 'min', '全文检索', 'Storage', 'guide']) {
      const compactRes = compactEngine.search(q);
      const snapRes = engine.search(q);
      expect(compactRes.length, q).toBe(snapRes.length);
      for (let i = 0; i < compactRes.length; i++) {
        expect(compactRes[i].id).toBe(snapRes[i].id);
        expect(compactRes[i].score).toBeCloseTo(snapRes[i].score, 2);
      }
    }
  });

  it('getOrLoadSearchEngine 单例缓存、故障降级 null 与 single-flight 并发合并', async () => {
    const okFetcher = async () => packedBuffer.buffer.slice(packedBuffer.byteOffset, packedBuffer.byteOffset + packedBuffer.byteLength);
    const e1 = await getOrLoadSearchEngine('facebook', 'react', okFetcher);
    expect(await getOrLoadSearchEngine('facebook', 'react', okFetcher)).toBe(e1);

    expect(await getOrLoadSearchEngine('org', 'broken-repo', async () => { throw new Error('404'); })).toBeNull();
    expect(await getOrLoadSearchEngine('org', 'corrupt', async () => new Uint8Array([0, 1, 2, 3]).buffer)).toBeNull();

    let calls = 0;
    const failing = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('503');
    };
    const [r1, r2, r3] = await Promise.all([
      getOrLoadSearchEngine('owner', 'offline', failing),
      getOrLoadSearchEngine('owner', 'offline', failing),
      getOrLoadSearchEngine('owner', 'offline', failing),
    ]);
    expect([r1, r2, r3, calls]).toEqual([null, null, null, 1]);
  });

  it('畸变/截断二进制流拦截、500 chunk 延迟 SLA 与同分稳定 tie-break', () => {
    expect(() => new BinarySearchEngine(Buffer.from('short'))).toThrowError(/too short/);
    const wrongMagic = Buffer.alloc(60);
    Buffer.from('FAIL').copy(wrongMagic, 0);
    expect(() => new BinarySearchEngine(wrongMagic)).toThrowError(/magic header/);
    expect(() => new BinarySearchEngine(packedBuffer.subarray(0, packedBuffer.length - 30))).toThrow();

    const largeBuf = packSearchIndex(
      {
        owner: 'perf',
        repo: 'bench',
        gitSha: 'sha',
        chunks: Array.from({ length: 500 }, (_, i) => ({
          id: `c-${i}`,
          docPath: `docs/m-${i % 20}.mdx`,
          title: `Module ${i % 20}`,
          heading: `Fn ${i}`,
          headingPath: `M > Fn ${i}`,
          content: `Synthetic ${i} authentication`,
          tokens: ['module', `fn${i}`, 'authentication'],
        })),
      },
      false
    );
    const t0 = performance.now();
    expect(new BinarySearchEngine(unpackSearchIndex(largeBuf)).search('authentication').length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(20);

    const tieBuf = packSearchIndex(
      {
        owner: 'test',
        repo: 'tie',
        gitSha: 'sha-tie',
        chunks: [
          { id: 'chunk-alpha', docPath: 'guide/a.mdx', title: '', heading: 'Stand Alone Section', headingPath: 'Stand Alone Section', content: 'tie', tokens: ['tie'] },
          { id: 'chunk-beta', docPath: 'guide/b.mdx', title: 'Has Title', heading: 'Section Beta', headingPath: 'Section Beta', content: 'tie', tokens: ['tie'] },
        ],
      },
      false
    );
    const tieRes = new BinarySearchEngine(tieBuf).search('tie');
    expect(tieRes.map((r) => r.id)).toEqual(['chunk-alpha', 'chunk-beta']);
    expect(tieRes[0].title).toBe('Stand Alone Section');
    expect(tieRes[1].title).toBe('Has Title › Section Beta');
  });

  it('WP-J slugify empty-drift fallback (Go mdpat.Slugify parity)', () => {
    expect(slugify('???')).toBe('h-79a2341835c376d4');
    expect(slugify('###')).toBe('h-cc56e417d397d540');
    expect(slugify('、。')).toBe('h-fd4d9f6fa2cfe54c');
    expect(slugify('！？')).toBe('h-c3e1c2f86d01f83b');
    expect(slugify('😀')).toBe('h-feff073875020288');
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('中文 标题')).toBe('中文-标题');
    expect(slugify('ビール 々')).toBe('ビール-々');
  });
});
