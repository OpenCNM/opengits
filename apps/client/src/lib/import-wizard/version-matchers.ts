/**
 * 导入向导「目标目录自动匹配」（认知层瘦身版）。
 *
 * 历史注记：原 7 级启发式责任链（代码仓判根 / 语言偏好 / 规则 textRoot /
 * 首个富目录兜底等）用死规则越权裁决「哪个目录是教程主体」——字母序盲选
 * 把 appendix-A/（rasbt/llms-from-scratch 转录事故）顶上推荐位，正文章节
 * ch01~ch07 整体丢失。按红线三（不用逻辑代码取代 LLM 认知），目录意图
 * 判断已归还 arbitrateScopeVerdict（scout 管线 AI 裁决，含根目录合法化），
 * 本文件只保留两类与意图无关的确定性匹配：
 *
 * 1. byExplicitPath：用户在 URL 里显式指定的子路径（用户明示意图，非猜测）；
 * 2. byPrimaryRole：AI 裁决的正文目录（role='primary'，'' 根目录同样合法）。
 *
 * 两环皆未命中 → 返回 null，由用户在确认页手动选择（人是最终闸门，
 * 不用规则冒充智能做第三环）。
 */

/** scout 探测产物中的版本目录条目（结构鸭子类型，避免耦合服务端类型） */
export interface ScoutVersionLike {
  prefix: string;
  totalFiles?: number;
  isOversized?: boolean;
  role?: string;
  lang?: string;
}

export interface VersionMatchContext {
  /** 用户在 URL 里指定的子目录（如 /tree/main/packages/reactivity） */
  filePath?: string | null;
}

const stripTrailingSlash = (p: string): string => p.replace(/\/$/, '');

/** 1. URL 显式子路径优先：/tree/main/packages/x 精确/后缀匹配该路径 */
export function byExplicitPath(versions: ScoutVersionLike[], ctx: VersionMatchContext): ScoutVersionLike | null {
  if (!ctx.filePath) return null;
  const normPath = stripTrailingSlash(ctx.filePath);
  if (!normPath) return null;
  return (
    versions.find((v) => {
      const normV = stripTrailingSlash(v.prefix);
      if (normV === normPath) return true;
      // 空串漂移防御：'' 的 endsWith 恒真，不得劫持显式路径匹配
      if (!normV) return false;
      return normV.endsWith(normPath) || normPath.endsWith(normV);
    }) ?? null
  );
}

/** 2. AI 裁决的正文目录（dir-verdict 合并条目带 role='primary'；'' 仓库根同样是合法主体答案） */
export function byPrimaryRole(versions: ScoutVersionLike[]): ScoutVersionLike | null {
  return versions.find((v) => v.role === 'primary') ?? null;
}

/** 匹配链：顺序执行，首个命中即返回；两环皆空返回 null（人工选择） */
export const VERSION_MATCHERS: Array<(versions: ScoutVersionLike[], ctx: VersionMatchContext) => ScoutVersionLike | null> = [
  byExplicitPath,
  byPrimaryRole,
];

/**
 * 兜底回落：URL 子路径补斜杠；无子路径时默认仓库根（最不坏的超集，
 * 用户在确认页仍可手动改选）——不再按字母序/丰富度盲猜子目录。
 */
export function fallbackPrefix(filePath?: string | null): string {
  if (filePath) {
    return filePath.endsWith('/') ? filePath : filePath + '/';
  }
  return '';
}

/**
 * 自动匹配目标目录：显式 URL → AI 裁决，两环即止。
 * 返回 null 表示无自动推荐，调用方走 fallbackPrefix 并由用户确认。
 */
export function matchScoutVersion(
  versions: ScoutVersionLike[],
  ctx: VersionMatchContext
): ScoutVersionLike | null {
  for (const matcher of VERSION_MATCHERS) {
    const matched = matcher(versions, ctx);
    if (matched) return matched;
  }
  return null;
}
