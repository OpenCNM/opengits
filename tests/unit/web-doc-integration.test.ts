import { describe, it, expect } from 'vitest';
import { inspectGithubUrl } from '@/lib/url-inspector';
import { buildWebNavTree } from '@/engine/web-doc/structurizer';
import type { DocumentItem } from '@/engine/web-doc/types';

// W2/W4 的行为测试：URL 分流判定、NavTree 顺序信号（W5 图片转存已随 TS 抓取引擎退役下沉 Go）

describe('url-inspector 网页文档分流', () => {
  it('非 GitHub 的 http(s) URL → web-doc 资源（isValid=true）', () => {
    const r = inspectGithubUrl('https://docs.astro.build/en/getting-started/');
    expect(r.isValid).toBe(true);
    expect(r.status).toBe('WEB_DOC_URL');
    expect(r.resourceType).toBe('web-doc');
    expect(r.webUrl).toBeTruthy();
  });

  it('GitHub URL 判定不受影响', () => {
    const r = inspectGithubUrl('https://github.com/vercel/next.js');
    expect(r.resourceType).toBe('repo');
    expect(r.isValid).toBe(true);
    const short = inspectGithubUrl('vercel/next.js');
    expect(short.resourceType).toBe('repo');
  });

  it('非 http(s) 协议（如 ftp）仍是 UNSUPPORTED_DOMAIN', () => {
    const r = inspectGithubUrl('ftp://example.com/docs');
    expect(r.isValid).toBe(false);
    expect(r.status).toBe('UNSUPPORTED_DOMAIN');
  });
});

describe('structurizer 主线顺序信号（导航区链接顺序优先于字典序）', () => {
  const doc = (path: string, url: string): DocumentItem => ({
    path, title: path, markdown: '# t', url, contentHash: 'h', headings: [],
  });

  it('orderUrls 主序：getting-started 应排在 basic-syntax 前（字典序相反）', () => {
    const documents = [
      doc('basic-syntax.md', 'https://x.com/basic-syntax'),
      doc('getting-started.md', 'https://x.com/getting-started'),
      doc('tools/index.md', 'https://x.com/tools/'),
    ];
    // 导航顺序信号：getting-started → basic-syntax → tools
    const tree = buildWebNavTree(documents, {
      orderUrls: ['https://x.com/getting-started', 'https://x.com/basic-syntax', 'https://x.com/tools/'],
    });
    const names = tree.map((n) => n.name);
    expect(names.indexOf('getting-started')).toBeLessThan(names.indexOf('basic-syntax'));
    expect(names.indexOf('basic-syntax')).toBeLessThan(names.indexOf('tools'));
  });

  it('无信号回退字典序；目录节点取子树最小信号序', () => {
    const documents = [
      doc('guide/a.md', 'https://x.com/guide/a'),
      doc('zzz-last.md', 'https://x.com/zzz-last'),
    ];
    const tree = buildWebNavTree(documents, { orderUrls: ['https://x.com/guide/a'] });
    // 有信号的 guide 目录排在无信号的 zzz-last 之前
    expect(tree[0].name).toBe('guide');
    // 无信号时回退字典序
    const treeNoSignal = buildWebNavTree(documents);
    expect(treeNoSignal[0].name).toBe('guide');
  });
});
