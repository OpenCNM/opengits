export interface RawTelemetryEvent {
  eventType: string;
  pageUrl: string;
  targetId?: string | null;
  duration?: number | null;
  createdAt: Date;
  metadata?: Record<string, unknown> | null;
}

export interface ChapterMeta {
  path: string;
  title?: string;
  wordCount: number;
  codeBlockCount: number;
  headingCount: number;
  pageUrl: string;
}

interface ScoreBreakdown {
  scrollProgress: number;
  timeProgress: number;
}

interface ChapterScore {
  path: string;
  score: number;
  breakdown: ScoreBreakdown;
  contentWeight: number;
  visitCount: number;
  totalDwellMs: number;
}

export interface ProgressResult {
  overallProgress: number;
  chapterScores: ChapterScore[];
  totalChapters: number;
  effectivelyRead: number;
  summary: {
    avgScore: number;
    maxScore: number;
    minScore: number;
  };
}

export interface ReadingFingerprintConfig {
  weights: {
    sectionCoverage: number;
    timeAdequacy: number;
    skipPenalty: number;
    revisitBonus: number;
  };
  thresholds: {
    sectionFocusMs: number;
    contentSkipMs: number;
    revisitWindowMs: number;
    readingSpeedWpm: number;
    minReadTimeMs: number;
    effectivelyReadScore: number;
  };
  contentWeights: {
    wordWeight: number;
    codeBlockWeight: number;
    headingWeight: number;
  };
  eventTypes: {
    pageView: string;
    sectionFocus: string;
    contentSkip: string;
    codeCopy: string;
  };
}
