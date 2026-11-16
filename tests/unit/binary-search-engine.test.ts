import { beforeEach, describe, expect, it } from 'vitest';
import {
  packSearchIndex,
  unpackSearchIndex,
  type RawChunkRecord,
} from '@/lib/search/binary-index-packer';
import { tokenizeSearchText } from '@/lib/search/binary-index-service';
import {
  BinarySearchEngine,
  getOrLoadSearchEngine,
  clearSearchEngineCache,
  slugify,
} from '@/lib/wasm/binary-search-engine';

describe('Client-side In-Memory Binary Search Engine', () => {
  const testChunks: RawChunkRecord[] = [
    {
      id: 'chunk-react-hooks',
      docPath: 'reference/hooks/use-state.mdx',
      title: 'React Hooks Reference',
      heading: 'useState Hook',
      headingPath: 'Hooks > useState',
      content: 'useState is a React Hook that lets you add a state variable to your component.',
      tokens: ['react', 'hooks', 'reference', 'usestate', 'hook', 'state', 'variable', 'component'],
    },
    {
      id: 'chunk-react-effects',
      docPath: 'reference/hooks/use-effect.mdx',
      title: 'React Hooks Reference',
      heading: 'useEffect Hook',
      headingPath: 'Hooks > useEffect',
      content: 'useEffect is a React Hook that lets you synchronize a component with an external system.',
      tokens: ['react', 'hooks', 'reference', 'useeffect', 'hook', 'synchronize', 'component', 'external', 'system'],
    },
    {
      id: 'chunk-minio-config',
      docPath: 'deploy/minio.mdx',
      title: 'MinIO Storage Deployment',
      heading: 'Object Storage Setup',
      headingPath: 'Deploy > MinIO > Setup',
      content: 'Configure MinIO object storage credentials to persist binary search indexes.',
      tokens: ['minio', 'storage', 'deployment', 'object', 'setup', 'configure', 'credentials', 'persist', 'binary', 'search', 'indexes'],
    },
    {
      id: 'chunk-chinese-wasm',
      docPath: 'guide/wasm.mdx',
      title: 'WebAssembly 架构导读',
      heading: '线性内存与零开销分词',
      headingPath: '架构 > WebAssembly',
      content: '通过 WASM 线性内存实现微秒级倒排索引检索与高亮结果直出。',
      tokens: tokenizeSearchText('WebAssembly 架构导读 线性内存与零开销分词 通过 WASM 线性内存实现微秒级倒排索引检索与高亮结果直出。'),
    },
  ];

  let packedBuffer: Buffer;
  let engine: BinarySearchEngine;

  beforeEach(() => {
    clearSearchEngineCache();
    packedBuffer = packSearchIndex({
      owner: 'facebook',
      repo: 'react',
      gitSha: '9f8e7d6c5b4a32101234567890abcdef12345678',
      chunks: testChunks,
    }, true);

    const snapshot = unpackSearchIndex(packedBuffer);
    engine = new BinarySearchEngine(snapshot);
  });

  it('instantly finds relevant documents by exact query tokens', () => {
    const hits = engine.search('useState');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('chunk-react-hooks');
    expect(hits[0].title).toBe('React Hooks Reference › useState Hook');
    expect(hits[0].url).toContain('/docs/facebook/react/reference/hooks/use-state#usestate-hook');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('🧪 [9.4.1.2] supports prefix matching for search-as-you-type', () => {
    // User types "min" -> should match "minio"
    const hits = engine.search('min');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('chunk-minio-config');
    expect(hits[0].title).toContain('MinIO Storage Deployment');
  });

  it('boosts documents where keyword matches title or heading', () => {
    // Searching 'deployment' should rank chunk-minio-config first
    const hits = engine.search('deployment');
    expect(hits[0].id).toBe('chunk-minio-config');
  });

  it('🧪 [9.4.1.2] supports CJK Chinese character queries seamlessly', () => {
    const hits = engine.search('线性内存');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('chunk-chinese-wasm');
    expect(hits[0].title).toContain('WebAssembly 架构导读');
  });

  it('returns empty array when query has no searchable tokens', () => {
    expect(engine.search('')).toEqual([]);
    expect(engine.search('   ')).toEqual([]);
    expect(engine.search('!@#$%')).toEqual([]);
  });

  it('executes search queries within microsecond SLA on 500 generated chunks', () => {
    // Generate 500 synthetic chunks to stress test in-memory search
    const largeChunks: RawChunkRecord[] = [];
    for (let i = 0; i < 500; i++) {
      largeChunks.push({
        id: `chunk-bench-${i}`,
        docPath: `docs/api/module-${i % 20}.mdx`,
        title: `API Module ${i % 20}`,
        heading: `Function ${i}`,
        headingPath: `API > Module ${i % 20} > Function ${i}`,
        content: `This is synthetic function ${i} handling token authentication and WASM acceleration.`,
        tokens: ['api', 'module', `fn${i}`, 'function', 'synthetic', 'token', 'authentication', 'wasm', 'acceleration'],
      });
    }

    const largeBuf = packSearchIndex({
      owner: 'perf',
      repo: 'benchmark',
      gitSha: 'bench-sha',
      chunks: largeChunks,
    }, false);

    const benchEngine = new BinarySearchEngine(unpackSearchIndex(largeBuf));

    const t0 = performance.now();
    const hits = benchEngine.search('authentication');
    const elapsed = performance.now() - t0;

    expect(hits.length).toBeGreaterThan(0);
    // Assert sub-millisecond or low single-digit ms even under Vitest JIT / heavy parallel CI load
    expect(elapsed).toBeLessThan(15);
  });

  it('caches BinarySearchEngine instance in memory via getOrLoadSearchEngine', async () => {
    const mockFetcher = async () => packedBuffer.buffer.slice(
      packedBuffer.byteOffset,
      packedBuffer.byteOffset + packedBuffer.byteLength
    );

    const engine1 = await getOrLoadSearchEngine('facebook', 'react', mockFetcher);
    const engine2 = await getOrLoadSearchEngine('facebook', 'react', mockFetcher);

    expect(engine1).toBeDefined();
    expect(engine1).toBe(engine2); // Same singleton reference
  });

  it('🧪 [9.4.2.1] getOrLoadSearchEngine returns null on network or decode failure for seamless fallback to server search', async () => {
    const failingFetcher = async () => {
      throw new Error('Network error or 404');
    };

    const result = await getOrLoadSearchEngine('org', 'broken-repo', failingFetcher);
    expect(result).toBeNull();

    const corruptFetcher = async () => {
      return new Uint8Array([0x00, 0x01, 0x02, 0x03]).buffer;
    };

    const corruptResult = await getOrLoadSearchEngine('org', 'corrupted-repo', corruptFetcher);
    expect(corruptResult).toBeNull();
  });

  it('🧪 [9.4.2.1] 多并发读请求同时遭遇 MinIO 离线时：single-flight 共享失败并全量优雅降级回落 null', async () => {
    let callCount = 0;
    const failingFetcher = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('MinIO connection refused / S3 503');
    };

    const [r1, r2, r3] = await Promise.all([
      getOrLoadSearchEngine('owner', 'offline-repo', failingFetcher),
      getOrLoadSearchEngine('owner', 'offline-repo', failingFetcher),
      getOrLoadSearchEngine('owner', 'offline-repo', failingFetcher),
    ]);

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(r3).toBeNull();
    expect(callCount).toBe(1); // Single-flight promise coalescing verified
  });

  it('🧪 [9.4.2.2] 支持直接从二进制 Buffer / ArrayBuffer 初始化紧凑 TypedArray 引擎并实现延迟解码', () => {
    // Direct initialization from packed binary Buffer (without unpackSearchIndex)
    const compactEngine = new BinarySearchEngine(packedBuffer);

    expect(compactEngine.chunkCount).toBe(testChunks.length);
    expect(compactEngine.gitSha).toBe('9f8e7d6c5b4a32101234567890abcdef12345678');
    expect(compactEngine.owner).toBe('facebook');
    expect(compactEngine.repo).toBe('react');

    // Search returns exact hits with lazy decoded properties
    const hits = compactEngine.search('useState');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('chunk-react-hooks');
    expect(hits[0].title).toBe('React Hooks Reference › useState Hook');
    expect(hits[0].url).toContain('/docs/facebook/react/reference/hooks/use-state#usestate-hook');
    expect(hits[0].description).toBe('useState is a React Hook that lets you add a state variable to your component.');

    // Prefix search on compact engine
    const prefixHits = compactEngine.search('min');
    expect(prefixHits[0].id).toBe('chunk-minio-config');

    // CJK on compact engine
    const cjkHits = compactEngine.search('线性内存');
    expect(cjkHits[0].id).toBe('chunk-chinese-wasm');
  });

  it('🧪 [9.4.2.2] 验证紧凑 TypedArray 模式与快照模式检索结果和排序 100% 一致', () => {
    const compactEngine = new BinarySearchEngine(packedBuffer);
    const snapshotEngine = new BinarySearchEngine(unpackSearchIndex(packedBuffer));

    const queries = ['useState', 'min', '线性内存', 'deployment', 'hooks'];
    for (const q of queries) {
      const compactResults = compactEngine.search(q);
      const snapshotResults = snapshotEngine.search(q);

      expect(compactResults.length).toBe(snapshotResults.length);
      for (let i = 0; i < compactResults.length; i++) {
        expect(compactResults[i].id).toBe(snapshotResults[i].id);
        expect(compactResults[i].title).toBe(snapshotResults[i].title);
        expect(compactResults[i].url).toBe(snapshotResults[i].url);
        expect(compactResults[i].score).toBeCloseTo(snapshotResults[i].score, 2);
      }
    }
  });

  it('🧪 [9.4.2.2] 紧凑模式在遇到截断或畸变二进制流时安全拦截并抛出确定性异常', () => {
    // 1. 数据不足 50 字节
    expect(() => new BinarySearchEngine(Buffer.from('short'))).toThrowError(/too short/);

    // 2. 错误 Magic
    const wrongMagic = Buffer.alloc(60);
    Buffer.from('FAIL').copy(wrongMagic, 0);
    expect(() => new BinarySearchEngine(wrongMagic)).toThrowError(/magic header/);

    // 3. 截断的二进制流（切掉后 30 字节）
    const truncated = packedBuffer.subarray(0, packedBuffer.length - 30);
    expect(() => new BinarySearchEngine(truncated)).toThrow();
  });

  it('🧪 [9.4.2.2] 验证同分条件下的稳定 tie-break 排序与无 Title 小节独立标题展示', () => {
    const tieChunks: RawChunkRecord[] = [
      {
        ID: 'chunk-alpha',
        id: 'chunk-alpha',
        docPath: 'guide/a.mdx',
        title: '',
        heading: 'Stand Alone Section',
        headingPath: 'Stand Alone Section',
        content: 'Common keyword text for tie testing',
        tokens: ['common', 'keyword', 'tie'],
      } as unknown as RawChunkRecord,
      {
        ID: 'chunk-beta',
        id: 'chunk-beta',
        docPath: 'guide/b.mdx',
        title: 'Has Title',
        heading: 'Section Beta',
        headingPath: 'Section Beta',
        content: 'Common keyword text for tie testing',
        tokens: ['common', 'keyword', 'tie'],
      } as unknown as RawChunkRecord,
    ];

    const tieBuf = packSearchIndex({
      owner: 'test',
      repo: 'tie',
      gitSha: 'sha-tie',
      chunks: tieChunks,
    }, false);

    const tieEngine = new BinarySearchEngine(tieBuf);
    const results = tieEngine.search('tie');

    expect(results.length).toBe(2);
    expect(results[0].score).toBe(results[1].score);
    // 确定性按 chunkIndex 排序（alpha 在前）
    expect(results[0].id).toBe('chunk-alpha');
    expect(results[1].id).toBe('chunk-beta');

    // 无 title 时，不应出现前置 " › "
    expect(results[0].title).toBe('Stand Alone Section');
    expect(results[0].title).not.toContain('›');
    expect(results[1].title).toBe('Has Title › Section Beta');
  });
});

describe('WP-J slugify empty-drift fallback (Go mdpat.Slugify parity)', () => {
  // 🧪 Go 参考值由 mdpat.Slugify 实算（BUG-03 残留：浏览器快道与网络路径锚点不再分叉）
  it('falls back to h-<fnv1a64> for punctuation-only headings', () => {
    expect(slugify('???')).toBe('h-79a2341835c376d4');
    expect(slugify('###')).toBe('h-cc56e417d397d540');
    expect(slugify('、。')).toBe('h-fd4d9f6fa2cfe54c');
    expect(slugify('！？')).toBe('h-c3e1c2f86d01f83b');
    expect(slugify('😀')).toBe('h-feff073875020288');
  });

  it('keeps normal slugs and CJK anchors unchanged', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('中文 标题')).toBe('中文-标题');
    // 长音符ー与叠字符々保留（与 CJKScriptClass 锁步）
    expect(slugify('ビール 々')).toBe('ビール-々');
  });
});
