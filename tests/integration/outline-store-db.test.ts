import { test, expect, describe, afterAll, beforeAll } from 'vitest';
import { prisma } from '@/lib/db';
import {
  storeOutlineDraft,
  activateOutline,
  deactivateAllOutlines,
} from '@/lib/mcp/outline-store';
import type { OutlineDraft } from '@/lib/mcp/ingest-orchestrator';
import { ENGINE_CONFIG } from '@/lib/config';

describe('outline-store DB 级版本编排与激活切换集成测试', () => {
  const testOwner = `ostore-owner-${Date.now()}`;
  const testRepo = `ostore-repo-${Date.now()}`;
  let repoId = '';
  let doc1Id = '';
  let doc2Id = '';

  beforeAll(async () => {
    const repo = await prisma.repository.create({
      data: {
        owner: testOwner,
        repo: testRepo,
        branch: ENGINE_CONFIG.defaultBranch,
        isPublic: true,
        category: 'Testing',
      },
    });
    repoId = repo.id;

    const d1 = await prisma.document.create({
      data: {
        repositoryId: repo.id,
        path: 'docs/chapter1.md',
        title: '第 1 章：基础',
        status: 'PROCESSED',
      },
    });
    doc1Id = d1.id;

    const d2 = await prisma.document.create({
      data: {
        repositoryId: repo.id,
        path: 'docs/chapter2.md',
        title: '第 2 章：进阶',
        status: 'PROCESSED',
      },
    });
    doc2Id = d2.id;
  });

  afterAll(async () => {
    if (repoId) {
      await prisma.tutorialOutline.deleteMany({ where: { repositoryId: repoId } }).catch(() => {});
      await prisma.document.deleteMany({ where: { repositoryId: repoId } }).catch(() => {});
      await prisma.repository.delete({ where: { id: repoId } }).catch(() => {});
    }
  });

  const draftV1: OutlineDraft = {
    parts: [
      { title: 'Part A 快速入门', summary: '入门指南', teachingOrder: 1 },
    ],
    chapters: [
      {
        title: '第一章 基础环境',
        summary: '环境搭建',
        chapterType: 'doc',
        teachingOrder: 1,
        partTitle: 'Part A 快速入门',
        nodes: [
          { title: '安装与配置', nodeType: 'doc', sourcePath: 'docs/chapter1.md' },
        ],
      },
    ],
  };

  const draftV2: OutlineDraft = {
    parts: [
      { title: 'Part A 快速入门', summary: '入门指南', teachingOrder: 1 },
      { title: 'Part B 架构核心', summary: '深入核心', teachingOrder: 2 },
    ],
    chapters: [
      {
        title: '第一章 基础环境',
        summary: '环境搭建',
        chapterType: 'doc',
        teachingOrder: 1,
        partTitle: 'Part A 快速入门',
        nodes: [
          { title: '安装与配置', nodeType: 'doc', sourcePath: 'docs/chapter1.md' },
        ],
      },
      {
        title: '第二章 核心原理',
        summary: '底层架构',
        chapterType: 'doc',
        teachingOrder: 2,
        partTitle: 'Part B 架构核心',
        nodes: [
          { title: '运行机制', nodeType: 'doc', sourcePath: 'docs/chapter2.md' },
        ],
      },
    ],
  };

  test('storeOutlineDraft：支持多版本自增与级联外键存储', async () => {
    // 1. 存储第 1 版（影子模式 isActive: false）
    const outline1Id = await storeOutlineDraft(repoId, draftV1, { isActive: false });
    const outline1 = await prisma.tutorialOutline.findUnique({
      where: { id: outline1Id },
      include: { parts: true, chapters: { include: { nodes: true } } },
    });

    expect(outline1).not.toBeNull();
    expect(outline1?.version).toBe(1);
    expect(outline1?.isActive).toBe(false);
    expect(outline1?.parts).toHaveLength(1);
    expect(outline1?.chapters).toHaveLength(1);
    expect(outline1?.chapters[0].nodes[0].documentId).toBe(doc1Id);

    // 2. 存储第 2 版（自动自增 version: 2，isActive: true）
    const outline2Id = await storeOutlineDraft(repoId, draftV2, { isActive: true });
    const outline2 = await prisma.tutorialOutline.findUnique({
      where: { id: outline2Id },
      include: { parts: true, chapters: { include: { nodes: true } } },
    });

    expect(outline2).not.toBeNull();
    expect(outline2?.version).toBe(2);
    expect(outline2?.isActive).toBe(true);
    expect(outline2?.parts).toHaveLength(2);
    expect(outline2?.chapters).toHaveLength(2);
  });

  test('activateOutline：同一仓库保证单活大纲原子切换', async () => {
    const outlines = await prisma.tutorialOutline.findMany({
      where: { repositoryId: repoId },
      orderBy: { version: 'asc' },
    });
    expect(outlines).toHaveLength(2);

    const [v1, v2] = outlines;

    // 切换激活第 1 版
    await activateOutline(repoId, v1.id);

    const freshV1 = await prisma.tutorialOutline.findUnique({ where: { id: v1.id } });
    const freshV2 = await prisma.tutorialOutline.findUnique({ where: { id: v2.id } });

    expect(freshV1?.isActive).toBe(true);
    expect(freshV2?.isActive).toBe(false);
  });

  test('deactivateAllOutlines：撤销全仓所有激活大纲', async () => {
    await deactivateAllOutlines(repoId);

    const activeOutlines = await prisma.tutorialOutline.findMany({
      where: { repositoryId: repoId, isActive: true },
    });
    expect(activeOutlines).toHaveLength(0);
  });
});
