import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GENERATION_LEVEL } from '@/lib/constants';
import { ChapterDegradedNotice } from '@/components/docs/ChapterDegradedNotice';

// Mock Next.js router
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
  }),
}));

describe('ChapterDegradedNotice (读者知情与结构化原文自愈组件)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('当等级为 TRANSLATED 时静默不渲染', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChapterDegradedNotice, {
        documentId: 'doc-1',
        generationLevel: GENERATION_LEVEL.TRANSLATED,
        targetLanguage: 'zh-CN',
      })
    );
    expect(html).toBe('');
  });

  it('当等级为 ENHANCED 时静默不渲染', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChapterDegradedNotice, {
        documentId: 'doc-1',
        generationLevel: GENERATION_LEVEL.ENHANCED,
        targetLanguage: 'zh-CN',
      })
    );
    expect(html).toBe('');
  });

  it('当无目标语言需求（targetLanguage 为 null 或 none）时静默不渲染', () => {
    const htmlNone = renderToStaticMarkup(
      React.createElement(ChapterDegradedNotice, {
        documentId: 'doc-1',
        generationLevel: GENERATION_LEVEL.ORIGINAL,
        targetLanguage: 'none',
      })
    );
    expect(htmlNone).toBe('');

    const htmlNull = renderToStaticMarkup(
      React.createElement(ChapterDegradedNotice, {
        documentId: 'doc-1',
        generationLevel: GENERATION_LEVEL.ORIGINAL,
        targetLanguage: null,
      })
    );
    expect(htmlNull).toBe('');
  });

  it('当存在目标语言且等级为 ORIGINAL 时渲染原文警示条与重新翻译按钮', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChapterDegradedNotice, {
        documentId: 'doc-123',
        generationLevel: GENERATION_LEVEL.ORIGINAL,
        targetLanguage: 'zh-CN',
      })
    );
    expect(html).toContain('data-testid="chapter-degraded-notice"');
    expect(html).toContain('button');
  });
});
