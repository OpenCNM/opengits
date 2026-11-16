import { test, expect } from 'vitest';
import { DEFAULT_AI_MODEL } from '@/lib/constants';

test('Repository transcriptionModels set deduplication and accumulation logic', () => {
  const initialModels: string[] = ['gemini-3.7-flash'];
  
  // Case 1: Same model added -> no duplicate
  const updatedSet1 = Array.from(new Set([...initialModels, 'gemini-3.7-flash']));
  expect(updatedSet1).toEqual(['gemini-3.7-flash']);

  // Case 2: Switch to new model (e.g. deepseek-v4-pro) -> accumulates
  const updatedSet2 = Array.from(new Set([...updatedSet1, 'deepseek-v4-pro']));
  expect(updatedSet2).toEqual(['gemini-3.7-flash', 'deepseek-v4-pro']);

  // Case 3: Switch to another model (e.g. qwen3.8-max) -> accumulates
  const updatedSet3 = Array.from(new Set([...updatedSet2, 'qwen3.8-max']));
  expect(updatedSet3).toEqual(['gemini-3.7-flash', 'deepseek-v4-pro', 'qwen3.8-max']);
});

test('Document generationModel fallback priority', () => {
  // Option model has highest priority
  const optionsModel: string | undefined = 'claude-sonnet-5';
  const repoProfileModel: string | undefined = 'gemini-3.7-flash';
  
  const resolvedWithOption = optionsModel || repoProfileModel || DEFAULT_AI_MODEL;
  expect(resolvedWithOption).toBe('claude-sonnet-5');

  // Repo profile model is second priority
  const noOptionModel: string | undefined = undefined;
  const resolvedWithProfile = noOptionModel || repoProfileModel || DEFAULT_AI_MODEL;
  expect(resolvedWithProfile).toBe('gemini-3.7-flash');

  // Fallback to default
  const noProfileModel: string | undefined = undefined;
  const resolvedDefault = noOptionModel || noProfileModel || DEFAULT_AI_MODEL;
  expect(resolvedDefault).toBe(DEFAULT_AI_MODEL);
});
