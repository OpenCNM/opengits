import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveGithubToken } from '@/lib/github/token-resolver';
import { prisma } from '@/lib/db';

vi.mock('@/lib/db', () => ({
  prisma: {
    account: {
      findFirst: vi.fn(),
    },
  },
}));

describe('GitHub Token Resolver (Dual-Track Token Delegation)', () => {
  const originalEnv = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.GITHUB_TOKEN = originalEnv;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('优先返回 explicitToken（显式指定的 Token 拥有最高优先级）', async () => {
    process.env.GITHUB_TOKEN = 'server-fallback-token';
    const token = await resolveGithubToken('user-1', { explicitToken: 'explicit-token-123' });
    expect(token).toBe('explicit-token-123');
    expect(prisma.account.findFirst).not.toHaveBeenCalled();
  });

  it('GitHub OAuth 登录用户优先解析其个人 access_token', async () => {
    process.env.GITHUB_TOKEN = 'server-fallback-token';
    vi.mocked(prisma.account.findFirst).mockResolvedValueOnce({
      access_token: 'gho_user_oauth_access_token_abc',
    } as any);

    const token = await resolveGithubToken('user-github-123');
    expect(token).toBe('gho_user_oauth_access_token_abc');
    expect(prisma.account.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-github-123',
        provider: 'github',
      },
      select: {
        access_token: true,
      },
    });
  });

  it('非 GitHub 登录用户（Apple / 邮箱）自动降级使用服务端 GITHUB_TOKEN', async () => {
    process.env.GITHUB_TOKEN = 'server-env-token-xyz';
    vi.mocked(prisma.account.findFirst).mockResolvedValueOnce(null);

    const token = await resolveGithubToken('user-apple-456');
    expect(token).toBe('server-env-token-xyz');
  });

  it('未登录/匿名访问且服务端未配置 GITHUB_TOKEN 时安全返回 undefined', async () => {
    delete process.env.GITHUB_TOKEN;
    const token = await resolveGithubToken(null);
    expect(token).toBeUndefined();
    expect(prisma.account.findFirst).not.toHaveBeenCalled();
  });

  it('DB 查询异常时优雅捕获并不阻断，降级为服务端 Token', async () => {
    process.env.GITHUB_TOKEN = 'server-env-token-fallback';
    vi.mocked(prisma.account.findFirst).mockRejectedValueOnce(new Error('DB Connection Timeout'));

    const token = await resolveGithubToken('user-err-789');
    expect(token).toBe('server-env-token-fallback');
  });
});
