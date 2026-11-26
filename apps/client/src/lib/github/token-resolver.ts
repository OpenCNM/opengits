import { prisma } from '@/lib/db';

export interface ResolveGithubTokenOptions {
  explicitToken?: string;
}

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

  const { acquirePoolToken } = await import('./token-pool');
  return acquirePoolToken()?.value;
}
