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

export function resolveEffectiveChapterVersion<T extends ChapterVersionSummary>(
  chapterVersions: T[],
  options: ResolveEffectiveVersionOptions = {}
): ResolvedChapterVersionResult<T> {
  const { versionParam, userId, validContentIds } = options;

  const sanitizedVersions = chapterVersions.map((v) => ({
    ...v,
    isCorrupted: !v.contentId || (validContentIds ? !validContentIds.has(v.contentId) : false),
  }));

  // Precedence: explicit ?v= > viewer private edition (unless ?v=canonical) > valid canonical > first valid.
  let targetCandidate: T | undefined;

  if (versionParam && versionParam !== 'canonical') {
    targetCandidate = sanitizedVersions.find(
      (cv) => cv.id === versionParam && (cv.visibility === 'PUBLIC' || cv.authorId === userId)
    );
  }

  if (!targetCandidate && versionParam !== 'canonical' && userId) {
    targetCandidate = sanitizedVersions.find((cv) => cv.visibility === 'PRIVATE' && cv.authorId === userId);
  }

  if (targetCandidate && !targetCandidate.isCorrupted) {
    return {
      activeVersion: targetCandidate,
      sanitizedVersions,
      hasFallback: false,
    };
  }

  const hasFallback = !!targetCandidate && !!targetCandidate.isCorrupted;

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

  const firstValid = sanitizedVersions.find((cv) => !cv.isCorrupted);
  if (firstValid) {
    return {
      activeVersion: firstValid,
      sanitizedVersions,
      hasFallback: true,
    };
  }

  return {
    activeVersion: null,
    sanitizedVersions,
    hasFallback: sanitizedVersions.length > 0 || Boolean(versionParam),
  };
}
