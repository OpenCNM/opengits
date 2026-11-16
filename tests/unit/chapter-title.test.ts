// 章节标题解构（lib/chapter-title）单测：覆盖扩展后的前缀形态与不应误拆的反例。

import { test, expect } from 'vitest';
import { parseChapterTitle } from '@/lib/chapter-title';

test('中文前缀：章/节/课 讲 单元 等序数后缀 + 各式分隔符', () => {
  expect(parseChapterTitle('第 0 章 — 引言：设计哲学')).toEqual({ index: '00', cleanTitle: '引言：设计哲学' });
  expect(parseChapterTitle('第1章：标题')).toEqual({ index: '01', cleanTitle: '标题' });
  expect(parseChapterTitle('第 10 章 - 多 Agent 协作')).toEqual({ index: '10', cleanTitle: '多 Agent 协作' });
  expect(parseChapterTitle('第 3 课 函数与闭包')).toEqual({ index: '03', cleanTitle: '函数与闭包' });
  expect(parseChapterTitle('第 2 单元 测试入门')).toEqual({ index: '02', cleanTitle: '测试入门' });
});

test('英文前缀：Lesson/Part/Unit/Module 与 Chapter/Ch 同权', () => {
  expect(parseChapterTitle('Chapter 1: Getting Started')).toEqual({ index: '01', cleanTitle: 'Getting Started' });
  expect(parseChapterTitle('chapter 12. Advanced Scaling')).toEqual({ index: '12', cleanTitle: 'Advanced Scaling' });
  expect(parseChapterTitle('Lesson 3 - Loops')).toEqual({ index: '03', cleanTitle: 'Loops' });
  expect(parseChapterTitle('Part 2 — Advanced')).toEqual({ index: '02', cleanTitle: 'Advanced' });
  expect(parseChapterTitle('Module 10 · 总结')).toEqual({ index: '10', cleanTitle: '总结' });
});

test('裸数字前缀：含顿号分隔', () => {
  expect(parseChapterTitle('01 - 快速上手')).toEqual({ index: '01', cleanTitle: '快速上手' });
  expect(parseChapterTitle('1. 标题')).toEqual({ index: '01', cleanTitle: '标题' });
  expect(parseChapterTitle('3、基础')).toEqual({ index: '03', cleanTitle: '基础' });
});

test('不应误拆：无序数前缀 / 序数词后无分隔 / 版本号形状', () => {
  expect(parseChapterTitle('全景架构总览')).toEqual({ index: null, cleanTitle: '全景架构总览' });
  // 序数词后没有分隔符（"第3天" 直接连标题）不拆，防误伤正文标题
  expect(parseChapterTitle('第3天连续集成')).toEqual({ index: null, cleanTitle: '第3天连续集成' });
  expect(parseChapterTitle('v15 迁移指南')).toEqual({ index: null, cleanTitle: 'v15 迁移指南' });
});

test('空值边界', () => {
  expect(parseChapterTitle('')).toEqual({ index: null, cleanTitle: '' });
});
