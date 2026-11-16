/**
 * 章节多版本生效投影器（自 lib/docs/docs-page-loader 收编入状态投影族）。
 * 纯函数：正典指针、私有优先、URL 覆盖与悬空脏数据安全回退的单一编码源。
 */

export interface ChapterVersionSummary {
  id: string;
  authorId?: string;
  voteCount?: number;
  isCanonical?: boolean;
  visibility?: 'PUBLIC' | 'PRIVATE' | string;
  source?: string;
  createdAt?: Date | string;
  contentId?: string | null;
  isCorrupted?: boolean;
  author?: { name: string | null; image: string | null };
}

export interface ResolveEffectiveVersionOptions {
  versionParam?: string;
  userId?: string | null;
  validContentIds?: Set<string>;
}

export interface ResolvedChapterVersionResult<T extends ChapterVersionSummary = ChapterVersionSummary> {
  activeVersion: T | null;
  sanitizedVersions: T[];
  hasFallback: boolean;
}

/**
 * 纯函数：解析当前生效的章节版本（正典指针、私有优先、URL 覆盖与悬空脏数据安全回退）。
 * 针对已被物理删除或 contentId 悬空的内容行标记 isCorrupted，
 * 并在选中版本损坏时自动 fallback 到首个有效正典或有效候选版本。
 */
export function resolveEffectiveChapterVersion<T extends ChapterVersionSummary>(
  chapterVersions: T[],
  options: ResolveEffectiveVersionOptions = {}
): ResolvedChapterVersionResult<T> {
  const { versionParam, userId, validContentIds } = options;

  // 1. 安全关联校验：过滤/标记悬空脏数据版本
  const sanitizedVersions = chapterVersions.map((v) => ({
    ...v,
    isCorrupted: !v.contentId || (validContentIds ? !validContentIds.has(v.contentId) : false),
  }));

  // 2. 候选版本匹配
  // 优先级：URL 显式 ?v= > 登录用户最新私有重译（当且仅当非 ?v=canonical）
  let targetCandidate: T | undefined;

  if (versionParam && versionParam !== 'canonical') {
    targetCandidate = sanitizedVersions.find(
      (cv) => cv.id === versionParam && (cv.visibility === 'PUBLIC' || cv.authorId === userId)
    );
  }

  if (!targetCandidate && versionParam !== 'canonical' && userId) {
    targetCandidate = sanitizedVersions.find((cv) => cv.visibility === 'PRIVATE' && cv.authorId === userId);
  }

  // 3. 验证所选候选版本是否有效（未损坏）
  if (targetCandidate && !targetCandidate.isCorrupted) {
    return {
      activeVersion: targetCandidate,
      sanitizedVersions,
      hasFallback: false,
    };
  }

  // 若用户指定了版本或命中私有版本，但该版本内容已物理损坏/悬空：
  const hasFallback = !!targetCandidate && !!targetCandidate.isCorrupted;

  // 优先取未损坏的正典版本
  const validCanonical = sanitizedVersions.find((cv) => cv.isCanonical && !cv.isCorrupted);
  if (validCanonical) {
    return {
      activeVersion: validCanonical,
      sanitizedVersions,
      hasFallback:
        hasFallback ||
        (Boolean(versionParam) && versionParam !== 'canonical' && versionParam !== validCanonical.id),
    };
  }

  // 若正典损坏，fallback 到首个未损坏的有效版本
  const firstValid = sanitizedVersions.find((cv) => !cv.isCorrupted);
  if (firstValid) {
    return {
      activeVersion: firstValid,
      sanitizedVersions,
      hasFallback: true,
    };
  }

  // 所有版本皆损坏或列表为空，fallback 为 null（外层回退渲染基底 doc.content）
  return {
    activeVersion: null,
    sanitizedVersions,
    hasFallback: sanitizedVersions.length > 0 || Boolean(versionParam),
  };
}
