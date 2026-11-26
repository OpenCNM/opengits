import { cleanChapterName } from '@/lib/llm-gateway/normalizers';

// FNV-1a maps non-ASCII/CJK course names deterministically to ASCII edition keys.
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

export function stripPhaseSuffix(title: string): string {
  const withoutPhase = (title || '').replace(PHASE_SUFFIX_REGEX, '').trim();
  return cleanChapterName(withoutPhase);
}

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
