import { test, expect, describe } from 'vitest';
import { parseChapterTitle } from '@/components/telemetry/SidebarProgressItem';

describe('SidebarProgressItem 章节标题解析与优化 (方案 B)', () => {
  test('解析中文章节编号与破折号', () => {
    expect(parseChapterTitle('第 0 章 — 引言：设计哲学')).toEqual({
      index: '00',
      cleanTitle: '引言：设计哲学',
    });

    expect(parseChapterTitle('第 1 章 — AI Agent 入门：从 LLM 到自主智能体')).toEqual({
      index: '01',
      cleanTitle: 'AI Agent 入门：从 LLM 到自主智能体',
    });

    expect(parseChapterTitle('第 10 章 — 多 Agent 协作网络')).toEqual({
      index: '10',
      cleanTitle: '多 Agent 协作网络',
    });

    expect(parseChapterTitle('第2章：上下文工程')).toEqual({
      index: '02',
      cleanTitle: '上下文工程',
    });
  });

  test('解析英文章节编号', () => {
    expect(parseChapterTitle('Chapter 1: Getting Started')).toEqual({
      index: '01',
      cleanTitle: 'Getting Started',
    });

    expect(parseChapterTitle('Ch 05 - Memory Systems')).toEqual({
      index: '05',
      cleanTitle: 'Memory Systems',
    });

    expect(parseChapterTitle('chapter 12. Advanced Scaling')).toEqual({
      index: '12',
      cleanTitle: 'Advanced Scaling',
    });
  });

  test('解析纯数字前缀', () => {
    expect(parseChapterTitle('01 - 快速上手')).toEqual({
      index: '01',
      cleanTitle: '快速上手',
    });

    expect(parseChapterTitle('2. 系统架构')).toEqual({
      index: '02',
      cleanTitle: '系统架构',
    });
  });

  test('无章节编号时完整保留原标题', () => {
    expect(parseChapterTitle('全景架构总览')).toEqual({
      index: null,
      cleanTitle: '全景架构总览',
    });

    expect(parseChapterTitle('后记：回归核心公式与技术展望')).toEqual({
      index: null,
      cleanTitle: '后记：回归核心公式与技术展望',
    });

    expect(parseChapterTitle('')).toEqual({
      index: null,
      cleanTitle: '',
    });
  });
});
