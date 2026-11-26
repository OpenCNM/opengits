// Fail closed in production when a secret env var is absent; allow devFallback only outside prod.
export function resolveSecret(envVar: string, devFallback: string): string {
  const value = process.env[envVar];
  if (value && value.trim().length > 0) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[security] ${envVar} 必须在生产环境设置。历史代码会静默回退到硬编码值（认证/信任绕过），现已改为 fail-fast。`
    );
  }
  return devFallback;
}
