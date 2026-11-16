import { createHash } from 'crypto';
import { isNonContentDir } from '@/engine/language-map';
import { ALLOWED_FILE_EXTENSIONS } from '@/lib/config';
import type { DetectionTreeNode } from './types';

/**
 * 特征提取纯函数层（零 DB、零副作用，全部可单测）。
 *
 * 骨架定义：从「源码树」计算而非 navTree——scout 阶段即可得出（建议横幅前置），
 * 且不随转录大纲/讲法选择而变。fork 与 clone 的骨架天然一致。
 * 讲法指纹：仓库内"换皮讲法"信号（preset+prompt+语言+深度 的配方 hash），
 * 仅同 (owner, repo) 组内比对——跨仓比会假阳性风暴，刻意不进检测器体系。
 */

/** 骨架参与比对的最小路径数：低于此值的小型脚手架仓跳过相似检测（防误报） */
export const SKELETON_MIN_PATHS = 8;
/** 骨架路径数上限：超大仓截断（trgm 成本与存储控制，精度几乎无损） */
export const SKELETON_MAX_PATHS = 500;
/** trgm 相似度判定阈值（admin 遥测可校准；展示用途，宁缺勿滥） */
export const SKELETON_SIMILARITY_THRESHOLD = 0.85;
/** 指纹输入的用户自由指令归一化长度上限 */
export const FINGERPRINT_PROMPT_MAX_CHARS = 2000;

/** 过滤出内容型 blob 路径：复用集中式分类规则（反硬编码红线——不在本文件内联清单） */
export function extractSkeletonPaths(treeNodes: DetectionTreeNode[]): string[] {
  return treeNodes
    .filter((n) => n && typeof n.path === 'string' && n.type === 'blob')
    .map((n) => n.path)
    .filter((p) => !isNonContentDir(p))
    .filter((p) => ALLOWED_FILE_EXTENSIONS.test(p));
}

/** 骨架串：小写 → 排序 → 截断 → 换行拼接（确定性：同树必同串） */
export function buildSkeleton(paths: string[]): string {
  return [...paths]
    .map((p) => p.toLowerCase())
    .sort()
    .slice(0, SKELETON_MAX_PATHS)
    .join('\n');
}

/** 骨架 hash：精确命中快路径（md5 十六进制） */
export function skeletonHashOf(skeleton: string): string {
  return createHash('md5').update(skeleton).digest('hex');
}

/** 骨架是否具备比对价值（路径数下限；小仓结构通用性太强） */
export function isSkeletonComparable(skeleton: string): boolean {
  if (!skeleton) return false;
  return skeleton.split('\n').length >= SKELETON_MIN_PATHS;
}

/**
 * 用户自由指令归一化：小写 + 去全部空白 + 去标点 + 截断。
 * 使「加点语气词的重写版」与原指令得到相同指纹（换皮检测的意义所在）。
 */
export function normalizePrompt(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, FINGERPRINT_PROMPT_MAX_CHARS);
}

/** 讲法指纹输入（转录配方四要素） */
export interface EditionFingerprintInput {
  preset?: string | null;
  customPrompt?: string | null;
  targetLanguage?: string | null;
  teachingDepth?: string | null;
}

/** 讲法指纹：同配方同 hash；任一要素实质变化即不同 */
export function buildEditionFingerprint(input: EditionFingerprintInput): string {
  const normalized = [
    input.preset || 'standard',
    normalizePrompt(input.customPrompt || ''),
    input.targetLanguage || 'none',
    input.teachingDepth || 'standard',
  ].join('|');
  return createHash('md5').update(normalized).digest('hex').slice(0, 16);
}
