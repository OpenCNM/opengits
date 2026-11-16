import { describe, expect, it } from 'vitest';
import {
  packSearchIndex,
  unpackSearchIndex,
  OGIS_MAGIC,
  OGIS_VERSION,
  type RawChunkRecord,
} from '@/lib/search/binary-index-packer';
import { tokenizeSearchText } from '@/lib/search/binary-index-service';

describe('OGIS v1 Binary Search Index Packer & Unpacker', () => {
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
      tokens: ['中', '文', '档', '测', '试', '全', '检', '索', '加', '速', 'webassembly', '内存', '浏览器', '实现', '微秒', '搜索', '高亮', '展示'],
    },
  ];

  it('🧪 [9.4.1.1] packs and unpacks an OGIS v1 binary index without data loss', () => {
    const packedGzip = packSearchIndex({
      owner: 'facebook',
      repo: 'react',
      gitSha: 'a1b2c3d4e5f678901234567890abcdef12345678',
      chunks: sampleChunks,
    }, true);

    expect(Buffer.isBuffer(packedGzip)).toBe(true);
    // Compressed size should be very small
    expect(packedGzip.length).toBeGreaterThan(100);
    expect(packedGzip.length).toBeLessThan(10000);

    const snapshot = unpackSearchIndex(packedGzip);
    expect(snapshot.magic).toBe(OGIS_MAGIC);
    expect(snapshot.version).toBe(OGIS_VERSION);
    expect(snapshot.owner).toBe('facebook');
    expect(snapshot.repo).toBe('react');
    expect(snapshot.gitSha).toBe('a1b2c3d4e5f678901234567890abcdef12345678');
    expect(snapshot.chunks.length).toBe(4);

    // Verify chunk 0 properties
    const chunk0 = snapshot.chunks[0];
    expect(chunk0.id).toBe('chk-1');
    expect(chunk0.docPath).toBe('guide/getting-started.mdx');
    expect(chunk0.title).toBe('Getting Started Guide');
    expect(chunk0.heading).toBe('Installation');
    expect(chunk0.snippet).toContain('npm install opengits-cli');

    // Verify chunk 3 (CJK) properties
    const chunk3 = snapshot.chunks[3];
    expect(chunk3.title).toBe('中文文档测试');
    expect(chunk3.heading).toBe('全文检索加速');
  });

  it('correctly calculates BM25 IDF for terms across the corpus', () => {
    const rawBuffer = packSearchIndex({
      owner: 'test-owner',
      repo: 'test-repo',
      gitSha: 'head',
      chunks: sampleChunks,
    }, false);

    const snapshot = unpackSearchIndex(rawBuffer);

    // 'opengits' appears in 2 chunks, 'minio' appears in 1 chunk
    const opengitsTerm = snapshot.terms.get('opengits');
    const minioTerm = snapshot.terms.get('minio');

    expect(opengitsTerm).toBeDefined();
    expect(minioTerm).toBeDefined();

    // Rarer terms must have higher IDF in BM25
    expect(minioTerm!.idf).toBeGreaterThan(opengitsTerm!.idf);
  });

  it('🧪 [9.4.1.2] tokenizes English, camelCase, snake_case, and CJK characters properly', () => {
    const text = 'getOrLoadSearchEngine uses minio_storage for 实时全文检索';
    const tokens = tokenizeSearchText(text);

    // Compound identifier decomposition
    expect(tokens).toContain('getorloadsearchengine');
    expect(tokens).toContain('load');
    expect(tokens).toContain('search');
    expect(tokens).toContain('engine');

    // Snake case decomposition
    expect(tokens).toContain('minio');
    expect(tokens).toContain('storage');

    // CJK characters
    expect(tokens).toContain('实');
    expect(tokens).toContain('时');
    expect(tokens).toContain('全');
    expect(tokens).toContain('文');
    expect(tokens).toContain('检');
    expect(tokens).toContain('索');
  });

  it('🧪 [9.4.1.1] rejects invalid or corrupted binary buffers with informative error', () => {
    const invalidBuffer = Buffer.from('NOT_AN_OGIS_FILE_HEADER_1234567890');
    expect(() => unpackSearchIndex(invalidBuffer)).toThrowError(/Invalid search index (magic header|buffer)/);
  });
});
