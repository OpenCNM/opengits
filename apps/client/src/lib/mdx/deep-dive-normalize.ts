import { DEEP_DIVE_LAYER_VALUE } from '@/lib/constants';

const DEEP_DIVE_LAYER_ALIASES = new Set<string>([
  DEEP_DIVE_LAYER_VALUE,
  'deep-dive',
  'deep_dive',
  'deepdive',
  '深挖',
  '深潜',
  '源码深潜',
  '源码深挖',
  '深入',
  '深入一步',
  '深入细节',
  '深度剖析',
  '深入剖析',
  '进阶',
]);

// Strip generic summary prefixes because the UI renders the localized deep-dive badge.
const DEEP_DIVE_SUMMARY_PREFIXES = [
  '源码深潜',
  '源码深挖',
  '深度剖析',
  '深入剖析',
  '深入一步',
  '深入细节',
  '深入理解',
  '深入探究',
  '进一步深入',
  '进阶阅读',
  '深入',
  '深挖',
  '深潜',
  '进阶',
  'deep dive',
  'deep-dive',
  'going deeper',
  'under the hood',
  'advanced',
] as const;

const SUMMARY_PREFIX_DELIMITERS = new Set(['：', ':', '—', '–', '-', '｜', '|']);

export function isDeepDiveLayerValue(raw?: string | null): boolean {
  if (!raw) return false;
  return DEEP_DIVE_LAYER_ALIASES.has(raw.trim().toLowerCase());
}

export function stripDeepDiveSummaryPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;

  const lower = trimmed.toLowerCase();
  for (const prefix of DEEP_DIVE_SUMMARY_PREFIXES) {
    if (!lower.startsWith(prefix)) continue;

    let idx = prefix.length;
    while (idx < trimmed.length && (trimmed[idx] === ' ' || trimmed[idx] === '\t')) {
      idx++;
    }
    if (idx >= trimmed.length || !SUMMARY_PREFIX_DELIMITERS.has(trimmed[idx])) {
      continue;
    }

    while (idx < trimmed.length && SUMMARY_PREFIX_DELIMITERS.has(trimmed[idx])) {
      idx++;
    }
    while (idx < trimmed.length && (trimmed[idx] === ' ' || trimmed[idx] === '\t')) {
      idx++;
    }

    const rest = trimmed.slice(idx).trim();
    if (rest) {
      return rest;
    }
  }

  return trimmed;
}
