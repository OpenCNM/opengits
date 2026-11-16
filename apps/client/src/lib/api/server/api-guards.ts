import { ApiError, ApiErrorCode } from './api-error';

/**
 * 1. 实体存在性断言：判空，若为空抛出标准 404 NOT_FOUND（自动收窄类型为 NonNullable<T>）。
 * 全站无论查用户、查仓库、查章节、查会话，统一复用本方法，严禁按业务对象定制独立 404 函数。
 */
export function assertFound<T>(value: T | null | undefined, detail?: string): NonNullable<T> {
  if (value === null || value === undefined) {
    throw ApiError.fromCode('NOT_FOUND', { detail });
  }
  return value;
}

/**
 * 3. 通用条件断言：若不满足条件，抛出指定标准系统状态码（自动匹配当前请求语言的多语言提示）。
 * 满足 condition 为真时直接向下执行；可附加 detail 用于调试，严禁在业务层编写裸 throw。
 */
export function assert(condition: unknown, code: ApiErrorCode, detail?: string): asserts condition {
  if (!condition) {
    throw ApiError.fromCode(code, { detail });
  }
}
