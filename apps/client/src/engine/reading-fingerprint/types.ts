/**
 * Reading Fingerprint Engine — Type Definitions
 * 
 * Pure type definitions with zero external dependencies.
 * This module defines the contract between the engine and any consumer.
 */

/** Raw telemetry event mapped from any data source */
export interface RawTelemetryEvent {
  eventType: string;
  pageUrl: string;
  targetId?: string | null;
  duration?: number | null;
  createdAt: Date;
  metadata?: Record<string, unknown> | null;
}

/** Chapter metadata for content weight calculation */
export interface ChapterMeta {
  path: string;
  title?: string;
  wordCount: number;
  codeBlockCount: number;
  headingCount: number;
  pageUrl: string;
}

/** Breakdown of a single chapter's score components */
interface ScoreBreakdown {
  scrollProgress: number;  // 0~100 (Max scroll depth)
  timeProgress: number;    // 0~100 (Dwell time progress)
}

/** Single chapter score result */
interface ChapterScore {
  path: string;
  score: number;             // Chapter score (0~100)
  breakdown: ScoreBreakdown;
  contentWeight: number;     // Normalized weight in [0,1]
  visitCount: number;
  totalDwellMs: number;
}

/** Aggregated progress result for an entire repository */
export interface ProgressResult {
  overallProgress: number;   // 0~100
  chapterScores: ChapterScore[];
  totalChapters: number;
  effectivelyRead: number;   // chapters with score >= threshold
  summary: {
    avgScore: number;
    maxScore: number;
    minScore: number;
  };
}

/** Engine configuration — all weights and thresholds */
export interface ReadingFingerprintConfig {
  weights: {
    sectionCoverage: number;   // α, default 0.35
    timeAdequacy: number;      // β, default 0.30
    skipPenalty: number;       // γ, default 0.20
    revisitBonus: number;      // δ, default 0.15
  };
  thresholds: {
    sectionFocusMs: number;    // min duration for SECTION_FOCUS, default 10000
    contentSkipMs: number;     // max duration for CONTENT_SKIP, default 1000
    revisitWindowMs: number;   // window for revisit detection, default 86400000 (24h)
    readingSpeedWpm: number;   // estimated reading speed (words/min), default 300
    minReadTimeMs: number;     // minimum estimated read time, default 10000
    effectivelyReadScore: number; // score threshold for 'effectively read', default 60
  };
  contentWeights: {
    wordWeight: number;        // per-word weight, default 1.0
    codeBlockWeight: number;   // per-code-block weight, default 50
    headingWeight: number;     // per-heading weight, default 20
  };
  eventTypes: {
    pageView: string;          // default 'PAGE_VIEW'
    sectionFocus: string;      // default 'SECTION_FOCUS'
    contentSkip: string;       // default 'CONTENT_SKIP'
    codeCopy: string;          // default 'CODE_COPY'
  };
}
