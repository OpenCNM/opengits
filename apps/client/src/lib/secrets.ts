/**
 * 生产环境密钥解析（fail-fast 策略）。
 *
 * 历史问题：多个密钥（NEXTAUTH_SECRET、HMAC 密钥）在 env 未设置时
 * 静默回退到源码里的硬编码值。后果是"配错"从"启动报错"降级为"静默沦陷"
 * （JWT/HMAC 可伪造、开放登录等）。体检基线 §3.A。
 *
 * 统一对策：生产模式下缺密钥就抛错（拒绝启动）；仅非生产允许显式 dev 兜底（本地开发便利）。
 */

/**
 * 解析必填密钥：env 有值则用；生产缺则抛错；非生产回退 devFallback。
 * @param envVar 环境变量名（用于报错信息）
 * @param devFallback 仅 NODE_ENV !== 'production' 时使用的开发兜底（必须含 insecure 标记，防误用）
 */
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
