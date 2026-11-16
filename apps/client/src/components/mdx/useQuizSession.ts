import { useState, useEffect, useRef } from 'react';
import { trackEvent, TELEMETRY_EVENTS } from '@/lib/telemetry/beacon';
import { safeGetJSON } from '@/lib/storage-utils';
import { redirectToSignIn } from '@/lib/api/client';
import * as m from '@/paraglide/messages';

export type TargetDifficulty = 'adaptive' | 'easy' | 'medium' | 'hard';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
  difficulty?: Difficulty;
}

export interface QuizSession {
  quizzes: QuizQuestion[];
  answers: Record<number, number>;
  submitted: Record<number, boolean>;
  hasStarted: boolean;
}

/** 持久化前单会话脱敏：未作答题剥离正确答案与解释 */
export function sanitizeSession(session: QuizSession): QuizSession {
  const stripQuiz = (quiz: QuizQuestion, revealed: boolean): QuizQuestion =>
    revealed ? quiz : { question: quiz.question, options: quiz.options, correctIndex: -1, difficulty: quiz.difficulty };
  return {
    ...session,
    quizzes: (session.quizzes || []).map((quiz, idx) => stripQuiz(quiz, Boolean(session.submitted[idx]))),
  };
}

/** 从存储恢复单会话时，若存在未揭示题目，丢弃不完整会话防止状态漂移 */
export function filterRestoredSession(session?: QuizSession): QuizSession {
  if (!session?.quizzes?.length) {
    return { quizzes: [], answers: {}, submitted: {}, hasStarted: false };
  }
  const allRevealed = session.quizzes.every(
    (q: QuizQuestion, idx: number) => session.submitted?.[idx] && typeof q.correctIndex === 'number' && q.correctIndex >= 0
  );
  if (!allRevealed) {
    return { quizzes: [], answers: {}, submitted: {}, hasStarted: false };
  }
  return session;
}

/** 持久化前脱敏（向后兼容测试）：未作答提交的题目剥离 correctIndex/explanation。 */
export function sanitizeSessions(input: Record<Difficulty, QuizSession>): Record<Difficulty, QuizSession> {
  const result = {} as Record<Difficulty, QuizSession>;
  for (const key of Object.keys(input) as Difficulty[]) {
    result[key] = sanitizeSession(input[key]);
  }
  return result;
}

/** 脱敏持久化恢复过滤（向后兼容测试） */
export function filterRestoredSessions(restored: Record<Difficulty, QuizSession>): Record<Difficulty, QuizSession> {
  const result = { ...restored };
  for (const key of Object.keys(result) as Difficulty[]) {
    result[key] = filterRestoredSession(result[key]);
  }
  return result;
}

/**
 * 测验生成会话。
 * 内容寻址快照契约（性能修复 2026-10-13）：不再把整章 MDX 原文作为 prop 传入
 * （正文已由 MDX 渲染输出，原文再次进 RSC payload 即双倍传输）；改传
 * (documentId, contentId)——contentId 是读者正在读的不可变版本快照，服务端
 * 自取内容并做归属与权限校验。
 */
export function useQuizSession(opts: { documentId: string; contentId: string | null }) {
  const [session, setSession] = useState<QuizSession>({
    quizzes: [],
    answers: {},
    submitted: {},
    hasStarted: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const generationTriggered = useRef(false);

  const storageKey = typeof window !== 'undefined' ? `quiz_state_${window.location.pathname}` : '';

  const persistSanitizedSession = (input: QuizSession) => {
    if (!storageKey) return;
    localStorage.setItem(
      storageKey,
      JSON.stringify({ session: sanitizeSession(input) })
    );
  };

  // Load from localStorage on mount
  useEffect(() => {
    if (!storageKey) return;
    const parsed = safeGetJSON<{ session?: any; sessions?: any; activeTab?: any } | null>(storageKey, null);
    if (parsed) {
      if (parsed.session) {
        setSession(filterRestoredSession(parsed.session));
      } else if (parsed.sessions) {
        const tab = parsed.activeTab || 'medium';
        const candidate = parsed.sessions[tab] || parsed.sessions.medium || parsed.sessions.easy || parsed.sessions.hard;
        if (candidate) {
          setSession(filterRestoredSession(candidate));
        }
      }
    }
  }, [storageKey]);

  // Sync state to localStorage on updates
  useEffect(() => {
    if (!storageKey) return;
    if (!session.quizzes || session.quizzes.length === 0) return;
    persistSanitizedSession(session);
  }, [session, storageKey]);

  const allSubmitted =
    session.quizzes.length > 0 &&
    session.quizzes.every((_, idx) => session.submitted[idx]);

  const resetCurrentSession = () => {
    const updated: QuizSession = { quizzes: [], answers: {}, submitted: {}, hasStarted: false };
    setSession(updated);
    if (storageKey) {
      localStorage.removeItem(storageKey);
    }
    generationTriggered.current = false;
  };

  const fetchQuiz = async (selectedDifficulty?: TargetDifficulty, enableThinking?: boolean) => {
    setSession((prev) => ({
      ...prev,
      hasStarted: true,
    }));

    setLoading(true);
    setError(null);
    setErrorCode(null);
    try {
      const res = await fetch('/api/quiz/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: opts.documentId,
          contentId: opts.contentId ?? undefined,
          enableThinking: Boolean(enableThinking),
          ...(selectedDifficulty ? { difficulty: selectedDifficulty } : {}),
        }),
      });
      if (res.status === 401) {
        setError(null);
        setErrorCode(null);
        redirectToSignIn();
        setSession((prev) => ({ ...prev, hasStarted: false }));
        return;
      }
      if (res.ok) {
        const json = await res.json();
        const data = json?.data;
        if (data?.quizzes && data.quizzes.length > 0) {
          const updated: QuizSession = {
            quizzes: data.quizzes,
            answers: {},
            submitted: {},
            hasStarted: true,
          };
          setSession(updated);
          persistSanitizedSession(updated);
        } else {
          setError(data?.message || m.quiz_generate_empty());
          setErrorCode('GENERATION_FAILED');
          setSession((prev) => ({ ...prev, hasStarted: false }));
        }
      } else {
        const errJson = await res.json().catch(() => null);
        const resolvedCode =
          errJson?.code ||
          (res.status === 409 || res.status === 400
            ? 'MISSING_API_KEY'
            : res.status === 429
            ? 'BUDGET_EXCEEDED'
            : 'GENERATION_FAILED');
        setError(errJson?.error || (res.status === 429 ? m.api_err_rate_limited() : m.quiz_fetch_failed()));
        setErrorCode(resolvedCode);
        setSession((prev) => ({ ...prev, hasStarted: false }));
      }
    } catch (e) {
      console.error(e);
      setError(m.quiz_network_error());
      setErrorCode('NETWORK_ERROR');
      setSession((prev) => ({ ...prev, hasStarted: false }));
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (qIndex: number, optIndex: number) => {
    if (session.submitted[qIndex]) return;
    setSession((prev) => ({
      ...prev,
      answers: { ...prev.answers, [qIndex]: optIndex },
    }));
  };

  const handleSubmit = (qIndex: number) => {
    setSession((prev) => ({
      ...prev,
      submitted: { ...prev.submitted, [qIndex]: true },
    }));

    const quiz = session.quizzes[qIndex];
    if (quiz && typeof quiz.correctIndex === 'number' && quiz.correctIndex >= 0) {
      const selected = session.answers[qIndex];
      const isCorrect = selected === quiz.correctIndex;
      try {
        trackEvent({
          eventType: TELEMETRY_EVENTS.QUIZ_INTERACTION,
          metadata: {
            difficulty: quiz.difficulty || 'medium',
            qIndex,
            isCorrect,
          },
        });
      } catch {}
    }
  };

  const handleRetryQuestion = (qIndex: number) => {
    setSession((prev) => {
      const newAnswers = { ...prev.answers };
      delete newAnswers[qIndex];
      const newSubmitted = { ...prev.submitted };
      delete newSubmitted[qIndex];

      return {
        ...prev,
        answers: newAnswers,
        submitted: newSubmitted,
      };
    });
  };

  return {
    quizzes: session.quizzes,
    answers: session.answers,
    submitted: session.submitted,
    hasStarted: session.hasStarted,
    currentSession: session,
    sessions: { easy: session, medium: session, hard: session },
    activeTab: 'medium' as Difficulty,
    setActiveTab: (_tab?: Difficulty) => {},
    loading,
    error,
    errorCode,
    allSubmitted,
    hasAnySessionStarted: session.hasStarted,
    generationTriggered,
    resetCurrentSession,
    fetchQuiz,
    handleSelect,
    handleSubmit,
    handleRetryQuestion,
  };
}
