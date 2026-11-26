import * as m from '@/paraglide/messages';
import { getLocale } from '@/paraglide/runtime.js';

export interface UsageSummary {
  tier: string;
  isAdmin: boolean;
  reposUsed: number;
  maxRepos: number;
  mcpCallsToday: number;
  dailyMcpCalls: number;
  tokens30d: number;
}

interface ScaleThreshold {
  threshold: number;
  suffix: string;
  divisor: number;
}

const EN_SCALES: ScaleThreshold[] = [
  { threshold: 1_000_000_000, suffix: 'B', divisor: 1_000_000_000 },
  { threshold: 1_000_000, suffix: 'M', divisor: 1_000_000 },
  { threshold: 1_000, suffix: 'k', divisor: 1_000 },
];

export function formatTokenCount(count: number): string {
  let lang = 'en';
  try {
    lang = getLocale();
  } catch {}

  if (lang === 'en') {
    for (const { threshold, suffix, divisor } of EN_SCALES) {
      if (count >= threshold) {
        return `${(count / divisor).toFixed(1)}${suffix}`;
      }
    }
    return count.toLocaleString();
  }

  if (count >= 100_000_000) {
    return `${(count / 100_000_000).toFixed(1)}${m.analytics_unit_hundred_million()}`;
  }
  if (count >= 10_000) {
    return `${(count / 10_000).toFixed(1)}${m.analytics_unit_ten_thousand()}`;
  }
  return count.toLocaleString();
}

export interface PhaseMetadata {
  title: () => string;
  desc: () => string;
}

export const PHASE_METADATA_MAP: Record<string, PhaseMetadata> = {
  import: {
    title: m.phase_import_title,
    desc: m.phase_import_desc,
  },
  transcription: {
    title: m.phase_transcription_title,
    desc: m.phase_transcription_desc,
  },
  chat: {
    title: m.phase_chat_title,
    desc: m.phase_chat_desc,
  },
  indexing: {
    title: m.phase_indexing_title,
    desc: m.phase_indexing_desc,
  },
};

export function getPhaseTitle(pk: string, defaultLabel: string): string {
  return PHASE_METADATA_MAP[pk]?.title() ?? defaultLabel;
}

export function getPhaseDesc(pk: string, defaultDesc: string): string {
  return PHASE_METADATA_MAP[pk]?.desc() ?? defaultDesc;
}
