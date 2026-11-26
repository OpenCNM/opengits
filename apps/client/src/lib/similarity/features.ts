import { createHash } from 'crypto';
import { isNonContentDir } from '@/engine/language-map';
import { ALLOWED_FILE_EXTENSIONS } from '@/lib/config';
import type { DetectionTreeNode } from './types';

// Source-tree skeleton is edition-independent; edition fingerprint is scoped per (owner, repo) to prevent cross-repo false positives.

export const SKELETON_MIN_PATHS = 8;
export const SKELETON_MAX_PATHS = 500;
export const SKELETON_SIMILARITY_THRESHOLD = 0.85;
export const FINGERPRINT_PROMPT_MAX_CHARS = 2000;

export function extractSkeletonPaths(treeNodes: DetectionTreeNode[]): string[] {
  return treeNodes
    .filter((n) => n && typeof n.path === 'string' && n.type === 'blob')
    .map((n) => n.path)
    .filter((p) => !isNonContentDir(p))
    .filter((p) => ALLOWED_FILE_EXTENSIONS.test(p));
}

export function buildSkeleton(paths: string[]): string {
  return [...paths]
    .map((p) => p.toLowerCase())
    .sort()
    .slice(0, SKELETON_MAX_PATHS)
    .join('\n');
}

export function skeletonHashOf(skeleton: string): string {
  return createHash('md5').update(skeleton).digest('hex');
}

export function isSkeletonComparable(skeleton: string): boolean {
  if (!skeleton) return false;
  return skeleton.split('\n').length >= SKELETON_MIN_PATHS;
}

export function normalizePrompt(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, FINGERPRINT_PROMPT_MAX_CHARS);
}

export interface EditionFingerprintInput {
  preset?: string | null;
  customPrompt?: string | null;
  targetLanguage?: string | null;
  teachingDepth?: string | null;
}

export function buildEditionFingerprint(input: EditionFingerprintInput): string {
  const normalized = [
    input.preset || 'standard',
    normalizePrompt(input.customPrompt || ''),
    input.targetLanguage || 'none',
    input.teachingDepth || 'standard',
  ].join('|');
  return createHash('md5').update(normalized).digest('hex').slice(0, 16);
}
