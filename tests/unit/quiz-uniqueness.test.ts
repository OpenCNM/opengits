import { describe, it, expect } from 'vitest';
import { quizGenerationSchema } from '@/app/api/quiz/generate/route';

describe('Quiz Options Uniqueness (A3)', () => {
  it('accepts valid quiz with 4 unique options', () => {
    const validQuiz = {
      quizzes: [
        {
          question: 'What is React?',
          options: ['A library', 'A database', 'An OS', 'A compiler'],
          correctIndex: 0,
          explanation: 'React is a JavaScript library for building user interfaces.',
        },
      ],
    };

    const parsed = quizGenerationSchema.safeParse(validQuiz);
    expect(parsed.success).toBe(true);
  });

  it('rejects quiz with duplicate options', () => {
    const invalidQuiz = {
      quizzes: [
        {
          question: 'What is React?',
          options: ['A library', 'A library', 'An OS', 'A compiler'],
          correctIndex: 0,
          explanation: 'Duplicate options.',
        },
      ],
    };

    const parsed = quizGenerationSchema.safeParse(invalidQuiz);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toContain('options must be unique');
    }
  });
});
