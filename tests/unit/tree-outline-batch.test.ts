import { describe, expect, it } from 'vitest';
import {
  shortHash,
  buildTreeCourseBatch,
  mergeTreeCoursesToSingleOutline,
} from '@/engine/tree-batch-utils';

/**
 * 树大纲单教程篇章大纲收敛与工具函数契约锁定:
 * 1. mergeTreeCoursesToSingleOutline: 多子课合并为单专栏大纲，挂载 partTitle 并保持章节序稳定；
 * 2. shortHash / buildTreeCourseBatch: 保留基础哈希与批量契约兼容。
 */

describe('tree outline single-course partTitle convergence', () => {
  it('多子课合并为单专栏章节大纲，正确挂载 partTitle 并维持章节序稳定', () => {
    const courses = [
      {
        name: '第一篇：全景架构总览',
        chapters: [
          { name: '第 1 章：系统拓扑与核心设计', files: ['README.md'] },
          { name: '第 2 章：主进程启动流', files: ['src/index.ts'] },
        ],
      },
      {
        name: '第二篇：存储与索引引擎',
        chapters: [
          { name: '第 3 章：存储驱动抽象', files: ['src/store/driver.ts'] },
          { name: '第 4 章：倒排索引与持久化', files: ['src/store/index.ts'] },
        ],
      },
    ];

    const result = mergeTreeCoursesToSingleOutline(courses);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      name: '第 1 章：系统拓扑与核心设计',
      files: ['README.md'],
      partTitle: '第一篇：全景架构总览',
    });
    expect(result[1]).toEqual({
      name: '第 2 章：主进程启动流',
      files: ['src/index.ts'],
      partTitle: '第一篇：全景架构总览',
    });
    expect(result[2]).toEqual({
      name: '第 3 章：存储驱动抽象',
      files: ['src/store/driver.ts'],
      partTitle: '第二篇：存储与索引引擎',
    });
    expect(result[3]).toEqual({
      name: '第 4 章：倒排索引与持久化',
      files: ['src/store/index.ts'],
      partTitle: '第二篇：存储与索引引擎',
    });
  });

  it('多子课合并时完整保留各章节课时的 companionFiles 协同文件上下文', () => {
    const courses = [
      {
        name: '网络传输篇',
        chapters: [
          {
            name: '第 1 章：连接管道',
            files: [
              {
                path: 'transport/pipe.go',
                shortTitle: 'Pipe 实现',
                companionFiles: ['transport/split.go', 'transport/buffer.go'],
              },
            ],
          },
        ],
      },
    ];

    const result = mergeTreeCoursesToSingleOutline(courses);
    expect(result).toHaveLength(1);
    expect(result[0].partTitle).toBe('网络传输篇');
    expect(result[0].files[0].companionFiles).toEqual(['transport/split.go', 'transport/buffer.go']);
  });

  it('处理无章节或空数组课程时不崩溃且顺序不漂移', () => {
    const courses = [
      { name: '第一篇', chapters: [{ name: 'ch1' }] },
      { name: '第二篇 (空)', chapters: [] },
      { name: '第三篇 (未定义章节)' },
      { name: '第四篇', chapters: [{ name: 'ch2' }] },
    ];

    const result = mergeTreeCoursesToSingleOutline(courses);
    expect(result).toHaveLength(2);
    expect(result[0].partTitle).toBe('第一篇');
    expect(result[0].name).toBe('ch1');
    expect(result[1].partTitle).toBe('第四篇');
    expect(result[1].name).toBe('ch2');
  });

  it('空输入返回空数组', () => {
    expect(mergeTreeCoursesToSingleOutline([])).toEqual([]);
  });

  it('自动清洗章节标题尾部的阶段后缀（(实战)/(入门)/(进阶)）', () => {
    const courses = [
      {
        name: '模块 1: 架构全景与快速上手',
        chapters: [
          { name: '第 1 章:全景与上手(入门)', files: ['README.md'] },
        ],
      },
      {
        name: '模块 2: 核心子系统实现',
        chapters: [
          { name: '第 2 章:transport(实战)', files: ['transport/pipe.go'] },
          { name: '第 3 章: proxy （进阶）', title: '第 3 章: proxy （进阶）', files: ['proxy/inbound.go'] },
        ],
      },
    ];

    const result = mergeTreeCoursesToSingleOutline(courses);
    expect(result[0].name).toBe('第 1 章:全景与上手');
    expect(result[1].name).toBe('第 2 章:transport');
    expect(result[2].name).toBe('第 3 章: proxy');
    expect(result[2].title).toBe('第 3 章: proxy');
  });
});

describe('tree outline legacy course batch compatibility', () => {
  it('总览课=基础 edition(空串),子课=ed_+稳定短哈希', () => {
    const batch = buildTreeCourseBatch(
      [
        { name: '第 1 章:全景与上手', chapters: [{ name: 'a' }] },
        { name: '第 2 章:pkg 核心实战', chapters: [{ name: 'b' }] },
        { name: '第 3 章:staging 公共库', chapters: [{ name: 'c' }] },
      ],
      '第 1 章:全景与上手',
    );
    expect(batch[0].edition).toBe('');
    expect(batch[0].editionLabel).toBe('第 1 章:全景与上手');
    expect(batch[1].edition).toMatch(/^ed_[0-9a-f]{8}$/);
    expect(batch[2].edition).not.toBe(batch[1].edition);
  });

  it('CJK 课程名哈希稳定且互异', () => {
    const h1 = shortHash('核心实现');
    const h2 = shortHash('核心实现');
    const h3 = shortHash('核心实现2');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
  });

  it('空课程名不坍缩', () => {
    expect(shortHash('')).toMatch(/^[0-9a-f]{8}$/);
  });
});
