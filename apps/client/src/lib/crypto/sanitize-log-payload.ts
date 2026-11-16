/**
 * 递归清洗日志与错误详情中的敏感凭证字段（API Keys / Tokens / Authorization Headers 等）。
 * 预防性脱敏，防止明文密钥被意外输出到控制台日志、Sentry 或回传到客户端 detail 字段。
 */

const SENSITIVE_KEY_PATTERNS = [
  /^api[-_]?key$/i,
  /^token$/i,
  /^secret$/i,
  /^auth(orization)?$/i,
  /^password$/i,
  /^credential(s)?$/i,
  /^bearer$/i,
  /^private[-_]?key$/i,
];

const API_KEY_STRING_PATTERNS = [
  /sk-[a-zA-Z0-9_\-]{15,}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /gho_[a-zA-Z0-9]{20,}/g,
  /Bearer\s+[a-zA-Z0-9._\-]+/gi,
];

export function sanitizeLogPayload<T>(obj: T, seen = new WeakSet<object>()): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    let sanitized: string = obj;
    for (const pattern of API_KEY_STRING_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
    return sanitized as unknown as T;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (seen.has(obj as object)) {
    return '[CIRCULAR]' as unknown as T;
  }
  seen.add(obj as object);

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeLogPayload(item, seen)) as unknown as T;
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const isSensitiveKey = SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
    if (isSensitiveKey) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizeLogPayload(value, seen);
    }
  }

  return result as unknown as T;
}
