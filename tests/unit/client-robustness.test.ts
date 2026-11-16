import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldPurgeReadingProgressKey, mergeMonotonicScores } from '@/lib/stores/reading-progress-store';
import { sanitizeSessions, filterRestoredSessions, type Difficulty, type QuizSession } from '@/components/mdx/useQuizSession';

describe('Client Robustness & State Resilience Tests (Real Implementations)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Reading progress store: mergeMonotonicScores & shouldPurgeReadingProgressKey', () => {
    it('mergeMonotonicScores guarantees monotonic progress and rejects regressions', () => {
      const current = { 'facebook/react:intro': 80, 'facebook/react:hooks': 100 };
      const incomingLower = { 'facebook/react:intro': 20, 'facebook/react:hooks': 50 };

      const { merged: mergedNoChange, hasDiff: diff1 } = mergeMonotonicScores(current, incomingLower);
      expect(mergedNoChange['facebook/react:intro']).toBe(80);
      expect(mergedNoChange['facebook/react:hooks']).toBe(100);
      expect(diff1).toBe(false);

      const incomingHigher = { 'facebook/react:intro': 95, 'facebook/react:new-doc': 40 };
      const { merged: mergedUpdated, hasDiff: diff2 } = mergeMonotonicScores(current, incomingHigher);
      expect(mergedUpdated['facebook/react:intro']).toBe(95);
      expect(mergedUpdated['facebook/react:hooks']).toBe(100);
      expect(mergedUpdated['facebook/react:new-doc']).toBe(40);
      expect(diff2).toBe(true);
    });

    it('shouldPurgeReadingProgressKey matches exact prefix without purging substring keys', () => {
      const repoKey = 'facebook/react';
      expect(shouldPurgeReadingProgressKey('reading_pos_v2_facebook/react:intro', repoKey)).toBe(true);
      expect(shouldPurgeReadingProgressKey('reading_pos_facebook/react:intro', repoKey)).toBe(true);
      expect(shouldPurgeReadingProgressKey('facebook/react:intro', repoKey)).toBe(true);

      // Unrelated keys containing repoKey as substring must NOT be purged
      expect(shouldPurgeReadingProgressKey('user_reactions_setting', repoKey)).toBe(false);
      expect(shouldPurgeReadingProgressKey('my-facebook/react-native:doc', repoKey)).toBe(false);
      expect(shouldPurgeReadingProgressKey('reading_pos_v2_facebook/react-native:intro', repoKey)).toBe(false);
    });
  });

  describe('Quiz session resilience: sanitizeSessions & filterRestoredSessions', () => {
    it('filterRestoredSessions drops incomplete sessions with unrevealed questions (correctIndex === -1)', () => {
      const input: Record<Difficulty, QuizSession> = {
        easy: {
          quizzes: [
            { question: 'Q1', options: ['A', 'B'], correctIndex: 0 },
            { question: 'Q2', options: ['A', 'B'], correctIndex: -1 },
          ],
          answers: { 0: 0 },
          submitted: { 0: true, 1: false },
          hasStarted: true,
        },
        medium: {
          quizzes: [
            { question: 'Q3', options: ['A', 'B'], correctIndex: 1 },
          ],
          answers: { 0: 1 },
          submitted: { 0: true },
          hasStarted: true,
        },
        hard: { quizzes: [], answers: {}, submitted: {}, hasStarted: false },
      };

      const sanitized = filterRestoredSessions(input);

      // Easy tab had an unrevealed question (correctIndex: -1), so it was safely discarded
      expect(sanitized.easy.quizzes).toHaveLength(0);
      expect(sanitized.easy.hasStarted).toBe(false);

      // Medium tab had all questions submitted & revealed (correctIndex >= 0), so it is retained
      expect(sanitized.medium.quizzes).toHaveLength(1);
      expect(sanitized.medium.hasStarted).toBe(true);
    });

    it('sanitizeSessions strips correctIndex to -1 for unsubmitted questions', () => {
      const input: Record<Difficulty, QuizSession> = {
        easy: {
          quizzes: [
            { question: 'Q1', options: ['A', 'B'], correctIndex: 0 },
            { question: 'Q2', options: ['A', 'B'], correctIndex: 1 },
          ],
          answers: { 0: 0 },
          submitted: { 0: true, 1: false },
          hasStarted: true,
        },
        medium: { quizzes: [], answers: {}, submitted: {}, hasStarted: false },
        hard: { quizzes: [], answers: {}, submitted: {}, hasStarted: false },
      };

      const result = sanitizeSessions(input);
      expect(result.easy.quizzes[0].correctIndex).toBe(0);
      expect(result.easy.quizzes[1].correctIndex).toBe(-1);
    });
  });
});
