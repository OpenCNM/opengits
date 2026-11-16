/**
 * apps/client/src/engine/tree-batch-utils.ts
 *
 * 树大纲批量课程与降噪工具函数（SSOT）:
 * 1. FNV-1a 短哈希：确保 CJK 与非 ASCII 课程名稳定映射到 edition 键；
 * 2. 批量课程契约构建：总览课绑定主版空串，子课绑定短哈希；
 * 3. 辅助目录确定性判定：识别测试、文档、样例等非核心目录。
 */

import { cleanChapterName } from '@/lib/llm-gateway/normalizers';

/** FNV-1a 短哈希(edition 键, CJK 课程名稳定映射) */
export function shortHash(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

interface TreeBatchCourse {
  name: string;
  chapters: unknown[];
}

interface TreeBatchItem {
  edition: string;
  editionLabel: string;
  chapters: unknown[];
}

const PHASE_SUFFIX_REGEX = /\s*[(（](?:入门|进阶|实战|intro|advanced|practice)[)）]\s*$/;

/** 清洗章节标题：剥离阶段后缀（如 "(实战)", "(入门)"）与物理代码扩展名（如 ".py", ".go"） */
export function stripPhaseSuffix(title: string): string {
  const withoutPhase = (title || '').replace(PHASE_SUFFIX_REGEX, '').trim();
  return cleanChapterName(withoutPhase);
}

/** 将多门子课合并为带有 partTitle 的单专栏章节大纲列表 */
export function mergeTreeCoursesToSingleOutline<T extends Record<string, any>>(
  courses: Array<{ name: string; chapters?: T[] }>,
): Array<T & { partTitle: string }> {
  return courses.flatMap((course) =>
    (course.chapters ?? []).map((ch) => {
      const cleanCh: Record<string, any> = { ...ch };
      if (typeof cleanCh.name === 'string') {
        cleanCh.name = stripPhaseSuffix(cleanCh.name);
      }
      if (typeof cleanCh.title === 'string') {
        cleanCh.title = stripPhaseSuffix(cleanCh.title);
      }
      cleanCh.partTitle = course.name;
      return cleanCh as T & { partTitle: string };
    })
  );
}

/** 将课程列表构建为批量导入载荷契约（总览课为主 edition，子课绑定短哈希） */
export function buildTreeCourseBatch(
  courses: TreeBatchCourse[],
  overviewName?: string,
): TreeBatchItem[] {
  return courses.map((course, i) => ({
    edition: i === 0 && course.name === overviewName ? '' : `ed_${shortHash(course.name)}`,
    editionLabel: course.name,
    chapters: course.chapters,
  }));
}

