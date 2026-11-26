import { ApiError, ApiErrorCode } from './api-error';

export function assertFound<T>(value: T | null | undefined, detail?: string): NonNullable<T> {
  if (value === null || value === undefined) {
    throw ApiError.fromCode('NOT_FOUND', { detail });
  }
  return value;
}

export function assert(condition: unknown, code: ApiErrorCode, detail?: string): asserts condition {
  if (!condition) {
    throw ApiError.fromCode(code, { detail });
  }
}
