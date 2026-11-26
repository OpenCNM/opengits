/**
 * 跨语言 golden fixture 生成器（Go 侧 ogis packer 的等价性证据）。
 *
 * 用 Node 原版 packSearchIndex + tokenizeSearchText + extractContextSnippet
 * 对固定 chunk 夹具产出：
 *   - services/worker-sidecar/testdata/ogis-fixture.bin  （OGIS v1 二进制）
 *   - services/worker-sidecar/testdata/ogis-fixture.json （chunks + tokens 语义描述）
 * Go 测试 gunzip .bin 后逐字段断言与 .json 一致（不比压缩字节——
 * Node zlib 与 Go compress/gzip 的 deflate 输出不同，靠 magic 探测互解）。
 *
 * 运行：cd apps/client && npx tsx ../../services/worker-sidecar/testdata/gen-ogis-fixture.mts
 * （本文件放 testdata 仅为贴近消费方；tsx 从 apps/client 起跑以解析 @/* 别名）
 */
import { writeFileSync } from 'node:fs';
import { packSearchIndex, type RawChunkRecord } from '@/lib/search/binary-index-packer';
import { tokenizeSearchText } from '@/lib/search/binary-index-service';
import { extractContextSnippet } from '@/lib/search/snippet';

const OWNER = 'vercel';
const REPO = 'next.js';
const GIT_SHA = '3f8a2c1d9b04e5678901234abcdef0123456789a';

const CHUNK_SOURCES: Array<{
  id: string;
  docPath: string;
  title: string;
  heading: string | null;
  headingPath: string | null;
  content: string;
}> = [
  {
    id: 'chunk-001',
    docPath: 'docs/getting-started.mdx',
    title: 'Getting Started',
    heading: 'Installation',
    headingPath: 'installation',
    content: `---
title: Getting Started
---

# Getting Started

Install \`next\` via \`usePackageManager\`:

\`\`\`bash
npm install next react react-dom
\`\`\`

The appRouter handles **server components** and caching.
<!-- internal note -->
See [the docs](https://example.com) and ![logo](https://example.com/l.png).
`,
  },
  {
    id: 'chunk-002',
    docPath: 'docs/app-router.mdx',
    title: 'App Router 指南',
    heading: '路由与渲染',
    headingPath: 'routing-and-rendering',
    content:
      'App Router 使用 React Server Components 实现流式渲染。' +
      '布局组件支持嵌套与模板复用，getServerSideProps 已被取代。' +
      '线性内存与二进制索引在中文检索场景下表现优秀。',
  },
  {
    id: 'chunk-003',
    docPath: 'docs/api-reference.mdx',
    title: 'API Reference',
    heading: null,
    headingPath: null,
    content: 'generateMetadata(props) and generateStaticParams(params) are async functions.',
  },
];

const chunks: RawChunkRecord[] = CHUNK_SOURCES.map((c) => ({
  id: c.id,
  docPath: c.docPath,
  title: c.title,
  heading: c.heading,
  headingPath: c.headingPath,
  content: extractContextSnippet(c.content, '', 160) || c.content.slice(0, 160),
  tokens: tokenizeSearchText(`${c.title} ${c.heading ?? ''} ${c.content}`),
}));

const bin = packSearchIndex({ owner: OWNER, repo: REPO, gitSha: GIT_SHA, chunks }, true, 1);

const OUT_DIR = '../../services/worker-sidecar/testdata';
writeFileSync(`${OUT_DIR}/ogis-fixture.bin`, bin);
writeFileSync(
  `${OUT_DIR}/ogis-fixture.json`,
  JSON.stringify(
    {
      owner: OWNER,
      repo: REPO,
      gitSha: GIT_SHA,
      chunks: chunks.map((c) => ({
        id: c.id,
        docPath: c.docPath,
        title: c.title,
        heading: c.heading ?? '',
        headingPath: c.headingPath ?? '',
        snippet: c.content.replace(/\s+/g, ' ').trim().slice(0, 160),
        tokens: c.tokens,
      })),
    },
    null,
    2,
  ),
);
console.log(`fixture written: ${chunks.length} chunks, ${bin.length} bytes (gzip level 1)`);
