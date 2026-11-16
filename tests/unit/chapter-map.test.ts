// 章节映射（Chapter Map）契约面单测（2026-09-17 Node 管线收刀版）：
// 降级阶梯编排（TOC 侧车 / 数字前缀 / BYOK LLM / 白名单校验）与课程树渲染
// 已整体下沉 Go worker-sidecar 进程内直跑——编排阶梯回归由 Go 侧
// internal/ingest/chapter_map_test.go 断言；本文件仅钉 Node 侧保留的
// 契约面：chapterMapSchema 容错解析。

import { test, expect } from 'vitest';
import { chapterMapSchema } from '@/engine/chapter-map';

// ---------- LLM 输出 schema 容错（与 Go ValidateChapterMap 互为冻结契约） ----------

test('chapterMapSchema：漂移字段回退默认值，任务不整体失败', () => {
  // 完整合法输出
  const full = chapterMapSchema.parse({
    isTutorial: true,
    chapters: [{ order: 1, title: 'Intro', mainPath: '01-intro.md', assetPaths: [{ path: 'lab.py', kind: 'exercise' }] }],
  });
  expect(full.chapters).toHaveLength(1);
  expect(full.chapters[0].assetPaths[0].kind).toBe('exercise');

  // 字段缺失/类型漂移 → catch 默认值
  const drifted = chapterMapSchema.parse({
    isTutorial: 'yes',           // 非布尔 → false
    chapters: [{ order: 'x', title: 42, mainPath: null, assetPaths: 'n/a' }], // 全漂移
  });
  expect(drifted.isTutorial).toBe(false);
  expect(drifted.chapters[0]).toEqual({ order: 0, title: '', mainPath: '', assetPaths: [] });

  // 整体缺 chapters → 空数组兜底
  expect(chapterMapSchema.parse({}).chapters).toEqual([]);
});
