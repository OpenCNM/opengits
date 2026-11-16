import { describe, it, expect } from 'vitest';
import {
  buildWebNavTree,
  formatTitleFromSegment,
} from '@/engine/web-doc/structurizer';
import { DocumentItem } from '@/engine/web-doc/types';

describe('WebDocEngine Structurizer', () => {
  it('格式化路径片段为人类可读的标题', () => {
    expect(formatTitleFromSegment('01-getting-started')).toBe('Getting Started');
    expect(formatTitleFromSegment('02_advanced_routing')).toBe('Advanced Routing');
    expect(formatTitleFromSegment('api-reference')).toBe('API Reference');
    expect(formatTitleFromSegment('overview')).toBe('Overview');
    expect(formatTitleFromSegment('01.01-installation')).toBe('Installation');
    expect(formatTitleFromSegment('02_grpc_service')).toBe('gRPC Service');
    expect(formatTitleFromSegment('ios_sdk_guide')).toBe('iOS SDK Guide');
  });

  it('将扁平文档集合构建为符合 OpenGits 规范的多级树状 NavNode[]', () => {
    const documents: DocumentItem[] = [
      {
        path: 'index.md',
        title: 'Introduction',
        markdown: '# Introduction\nWelcome to docs.',
        url: 'https://example.com/docs',
        contentHash: 'hash-0',
        headings: [{ level: 1, text: 'Introduction', id: 'introduction' }],
      },
      {
        path: 'guide/01-installation.md',
        title: 'Installation Guide',
        markdown: '# Installation\nnpm install example',
        url: 'https://example.com/docs/guide/installation',
        contentHash: 'hash-1',
        headings: [{ level: 1, text: 'Installation', id: 'installation' }],
      },
      {
        path: 'guide/02-configuration.md',
        title: 'Configuration',
        markdown: '# Configuration\nConfig options.',
        url: 'https://example.com/docs/guide/configuration',
        contentHash: 'hash-2',
        headings: [{ level: 1, text: 'Configuration', id: 'configuration' }],
      },
      {
        path: 'api/core.md',
        title: 'Core API',
        markdown: '# Core API\nAPI reference.',
        url: 'https://example.com/docs/api/core',
        contentHash: 'hash-3',
        headings: [{ level: 1, text: 'Core API', id: 'core-api' }],
      },
    ];

    const navTree = buildWebNavTree(documents);

    // 顶级应该包含 index, guide 目录, api 目录
    expect(navTree.length).toBe(3);

    // index 应该排在最前
    expect(navTree[0].name).toBe('index');
    expect(navTree[0].type).toBe('file');
    expect(navTree[0].title).toBe('Introduction');

    // guide 目录应该包含 2 个子文件
    const guideDir = navTree.find((n) => n.name === 'guide');
    expect(guideDir).toBeDefined();
    expect(guideDir?.type).toBe('directory');
    expect(guideDir?.children?.length).toBe(2);
    expect(guideDir?.children?.[0].name).toBe('01-installation');
    expect(guideDir?.children?.[0].title).toBe('Installation Guide');
    expect(guideDir?.children?.[1].name).toBe('02-configuration');

    // api 目录
    const apiDir = navTree.find((n) => n.name === 'api');
    expect(apiDir).toBeDefined();
    expect(apiDir?.children?.length).toBe(1);
    expect(apiDir?.children?.[0].title).toBe('Core API');
  });

  it('空文档集合返回空树', () => {
    const tree = buildWebNavTree([]);
    expect(tree).toEqual([]);
  });

  it('同名段冲突：裸索引页先落文件节点，更深路径将其晋升为目录而不崩溃', () => {
    // 复现 gpui-component 实测崩溃：/docs 裸索引页先建 docs 文件节点（无 children），
    // /docs/installation 需经 docs 下沉——晋升前 currentLevel 变 undefined 抛
    // "Cannot read properties of undefined (reading 'find')"
    const documents: DocumentItem[] = [
      {
        path: 'docs.md',
        title: 'Docs Home',
        markdown: '# Docs',
        url: 'https://example.com/docs',
        contentHash: 'h-bare',
        headings: [{ level: 1, text: 'Docs', id: 'docs' }],
      },
      {
        path: 'docs/installation.md',
        title: 'Installation',
        markdown: '# Install',
        url: 'https://example.com/docs/installation',
        contentHash: 'h-install',
        headings: [{ level: 1, text: 'Install', id: 'install' }],
      },
    ];

    const navTree = buildWebNavTree(documents);

    expect(navTree.length).toBe(1);
    const docsNode = navTree[0];
    // 晋升为目录：children 补挂、type 翻转、url 保留（索引页仍可链接）
    expect(docsNode.name).toBe('docs');
    expect(docsNode.type).toBe('directory');
    expect(docsNode.children?.length).toBe(1);
    expect(docsNode.children?.[0].name).toBe('installation');
    expect(docsNode.sourceUrl).toBe('https://example.com/docs');
  });

  it('同名段冲突（反序）：目录先建，裸索引页后到不破坏既有树', () => {
    const documents: DocumentItem[] = [
      {
        path: 'docs/installation.md',
        title: 'Installation',
        markdown: '# Install',
        url: 'https://example.com/docs/installation',
        contentHash: 'h-install',
        headings: [],
      },
      {
        path: 'docs.md',
        title: 'Docs Home',
        markdown: '# Docs',
        url: 'https://example.com/docs',
        contentHash: 'h-bare',
        headings: [],
      },
    ];

    const navTree = buildWebNavTree(documents);
    const docsNode = navTree.find((n) => n.name === 'docs');
    expect(docsNode).toBeDefined();
    expect(docsNode?.children?.length).toBe(1);
  });

  
  it('buildWebNavTree 支持多级编号章节自然排序，绝不倒错 1.1 与 1.2', () => {
    const documents: DocumentItem[] = [
      {
        path: 'guide/1.10-advanced.md',
        title: 'Advanced',
        markdown: '# Advanced',
        url: 'https://example.com/guide/1.10-advanced',
        contentHash: 'h-10',
        headings: [],
      },
      {
        path: 'guide/1.2-config.md',
        title: 'Config',
        markdown: '# Config',
        url: 'https://example.com/guide/1.2-config',
        contentHash: 'h-2',
        headings: [],
      },
      {
        path: 'guide/1.1-setup.md',
        title: 'Setup',
        markdown: '# Setup',
        url: 'https://example.com/guide/1.1-setup',
        contentHash: 'h-1',
        headings: [],
      },
    ];

    const navTree = buildWebNavTree(documents);
    const guideDir = navTree.find((n) => n.name === 'guide');
    expect(guideDir).toBeDefined();
    expect(guideDir?.children?.length).toBe(3);

    // 自然数字序：1.1 -> 1.2 -> 1.10（绝不因为 title Config 排在 Setup 前面而倒序）
    expect(guideDir?.children?.[0].name).toBe('1.1-setup');
    expect(guideDir?.children?.[1].name).toBe('1.2-config');
    expect(guideDir?.children?.[2].name).toBe('1.10-advanced');
  });
});
