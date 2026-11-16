// 章节映射（Chapter Map）契约面：仓库"章节结构"语义识别的去正则化。
//
// 2026-09-17 Node 管线收刀终局：降级阶梯编排（TOC 金标准 → 数字前缀 → BYOK LLM
// 小任务 → 路径白名单校验）已整体下沉 Go worker-sidecar 进程内直跑
// （internal/ingest/chapter_map.go runChapterMapChain），本文件仅保留
// 跨端契约单一事实源：
// - 数据模型（ChapterMapEntry 等，docs-page-loader / repo-sniffer 类型消费）
// - chapterMapSchema（llm-gateway registry purpose=chapter_map 的结构化输出
//   schema，与 Go ValidateChapterMap 复刻互为冻结契约）。
// 确定性段实现与 golden 断言全部在 Go（chapter-map.golden.json 锁定）。

import { z } from 'zod';

// ---------- 数据模型（Schema 三层同步：本接口 + chapterMapSchema + RepoProfile.chapterMap） ----------

type ChapterAssetKind = 'exercise' | 'example' | 'answer' | 'resource';

interface ChapterMapAsset {
  path: string;
  kind: ChapterAssetKind;
}

export interface ChapterMapEntry {
  /** 教学顺序（1 起，校验后连续重编号） */
  order: number;
  /** 章节标题（LLM 提取；空则由文件名确定性派生） */
  title: string;
  /** 章节正文文件（文档类文件） */
  mainPath: string;
  /** 章节附属资产（实验代码/示例/答案/资源） */
  assetPaths: ChapterMapAsset[];
}

// ---------- LLM 输出 schema（全字段容错：漂移字段回退默认值，任务不整体失败） ----------

export const chapterMapSchema = z.object({
  isTutorial: z
    .boolean()
    .catch(false)
    .describe('True only if the repository contains an ordered tutorial/book chapter sequence.'),
  chapters: z
    .array(
      z.object({
        order: z.number().catch(0).describe('Reading order of the chapter, starting at 1.'),
        title: z
          .string()
          .catch('')
          .describe('Chapter title in the document language; derive from content or filename.'),
        mainPath: z
          .string()
          .catch('')
          .describe('Repository path of the chapter main reading file, copied VERBATIM from the candidate list.'),
        assetPaths: z
          .array(
            z.object({
              path: z.string().catch(''),
              kind: z.enum(['exercise', 'example', 'answer', 'resource']).catch('resource'),
            })
          )
          .catch([])
          .describe('Auxiliary files belonging to this chapter: labs, exercises, examples, answer keys, resources.'),
      })
    )
    .catch([]),
});
