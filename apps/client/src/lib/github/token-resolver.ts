import { prisma } from '@/lib/db';

export interface ResolveGithubTokenOptions {
  explicitToken?: string;
}

/**
 * 解析 GitHub API 请求凭据（双轨制）：
 * 1. 优先使用传入的显式 Token（如子系统显式指定）
 * 2. 优先使用当前用户的 GitHub OAuth access_token（独立 5,000 次/小时配额，不占平台公共配额）
 * 3. 降级使用服务端环境变量 GITHUB_TOKEN
 * 4. 若均无则返回 undefined（安全降级走匿名限流控制）
 */
export async function resolveGithubToken(
  userId?: string | null,
  options?: ResolveGithubTokenOptions
): Promise<string | undefined> {
  if (options?.explicitToken) {
    return options.explicitToken;
  }

  if (userId) {
    try {
      const account = await prisma.account.findFirst({
        where: {
          userId,
          provider: 'github',
        },
        select: {
          access_token: true,
        },
      });

      if (account?.access_token) {
        return account.access_token;
      }
    } catch (error) {
      console.warn('[TokenResolver] Failed to resolve user github OAuth token:', error);
    }
  }

  // 平台侧：token 池轮询（GITHUB_TOKENS ∪ GITHUB_TOKEN）；池全冷却返回 undefined（匿名限流语义）
  const { acquirePoolToken } = await import('./token-pool');
  return acquirePoolToken()?.value;
}
