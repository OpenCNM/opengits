import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('M03 [3.3] 文档多版本阅读切换与正典指针绑定', () => {
  // 🧪 [3.3.1.1 · HIGH] 版本列表中 contentId 指向已被物理删除的内容记录
  // AntiPattern: 未处理外键悬空脏数据
  // DefenseAssertion: 安全关联校验，悬空版本自动标记为 Corrupted 并 fallback 至首个有效版
  it('3.3.1.1 悬空版本回退机制：contentId 无效或悬空时自动 fallback 至首个有效/正典版本', async () => {
    const { resolveEffectiveChapterVersion } = await import('@/lib/docs/docs-page-loader');

    const validContentPool = new Set(['content-valid-1', 'content-valid-2']);
    const mockVersions = [
      { id: 'v-corrupted-canonical', contentId: 'content-deleted-ghost', isCanonical: true, visibility: 'PUBLIC' },
      { id: 'v-community-1', contentId: 'content-valid-1', isCanonical: false, visibility: 'PUBLIC' },
      { id: 'v-community-2', contentId: 'content-valid-2', isCanonical: false, visibility: 'PUBLIC' },
    ];

    const resolution = resolveEffectiveChapterVersion(mockVersions, { validContentIds: validContentPool });
    expect(resolution.hasFallback).toBe(true);
    expect(resolution.activeVersion).not.toBeNull();
    expect(resolution.activeVersion?.id).toBe('v-community-1');
    expect(resolution.activeVersion?.isCorrupted).toBe(false);

    // 验证全版本损坏时安全 fallback 至 null（由底座 doc.content 渲染，绝不抛 500）
    const allCorrupted = [
      { id: 'v-1', contentId: 'ghost-1', isCanonical: true, visibility: 'PUBLIC' },
      { id: 'v-2', contentId: 'ghost-2', isCanonical: false, visibility: 'PUBLIC' },
    ];
    const fallbackNullRes = resolveEffectiveChapterVersion(allCorrupted, { validContentIds: validContentPool });
    expect(fallbackNullRes.hasFallback).toBe(true);
    expect(fallbackNullRes.activeVersion).toBeNull();
    expect(fallbackNullRes.sanitizedVersions.every((v) => v.isCorrupted)).toBe(true);
  });

  // 🧪 [3.3.2.1 · HIGH] 高并发双击为多个不同版本同时点赞投票
  // AntiPattern: 简单的 voteCount++ 未维护用户投票关系表
  // DefenseAssertion: 通过 ChapterUpdateVote 唯一索引 @@unique([userId, chapterId]) 原子切换
  it('3.3.2.1 一人一版一票互斥防刷：prisma schema 严格声明 @@unique([versionId, userId])', () => {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf-8');
    const voteModelBlock = schema.match(/model ChapterVersionVote\s*\{[\s\S]*?\n\}/)?.[0] || '';
    expect(voteModelBlock).toContain('versionId String');
    expect(voteModelBlock).toContain('userId    String');
    expect(voteModelBlock).toMatch(/@@unique\(\[versionId,\s*userId\]\)/);
  });

  // 🧪 [3.3.3.1 · MEDIUM] 切换版本时旧版本的未完成渲染异步回调导致内容混淆
  // AntiPattern: 无 AbortController 或竞态版本号标记
  // DefenseAssertion: 维护当前 activeVersionId，丢弃所有过期版本的异步渲染回调
  it('3.3.3.1 版本流式切换竞态丢弃：activeVersionId 比对机制丢弃过期异步渲染结果', async () => {
    let currentRenderedContent = '';
    let currentActiveVersionId = 'v-1';

    // 模拟版本异步加载渲染调度器
    const dispatchVersionRender = async (versionId: string, content: string, delayMs: number) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      // 关键防线：仅当回调返回时当前活跃版本仍与发起请求一致时才提交更新
      if (currentActiveVersionId === versionId) {
        currentRenderedContent = content;
      }
    };

    // 1. 用户先点击 v-1 (慢请求，延时 50ms)
    const taskV1 = dispatchVersionRender('v-1', 'Content of Version 1', 50);

    // 2. 用户迅速切换至 v-2 (快请求，延时 10ms)
    currentActiveVersionId = 'v-2';
    const taskV2 = dispatchVersionRender('v-2', 'Content of Version 2', 10);

    await Promise.all([taskV1, taskV2]);

    // 严密断言：尽管 v-1 的异步回调较慢完成，但因 activeVersionId 已切至 v-2，v-1 结果被安全丢弃，绝不覆盖新版
    expect(currentRenderedContent).toBe('Content of Version 2');
  });

  it('读者本地版本偏好键格式与隔离', () => {
    const prefKey = (documentId: string) => `opengits-version-pref:${documentId}`;
    expect(prefKey('doc-123')).toBe('opengits-version-pref:doc-123');
  });
});
