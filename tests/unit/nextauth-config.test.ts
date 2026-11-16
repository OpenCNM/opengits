import { describe, it, expect } from 'vitest';
import { resolveMaintainerUserId } from '@/lib/repository-maintainer';
import { authOptions } from '@/lib/auth-helper';

describe('M08 [8.2] NextAuth Provider Configuration & Security', () => {
  it('8.2.1.1 维护者身份解析函数导出有效', () => {
    expect(typeof resolveMaintainerUserId).toBe('function');
  });

  it('8.2.2.1 OAuth 认证模式与环境变量配置检查（严禁免密凭证登录）', () => {
    const credentialProviders = authOptions.providers.filter((p) => p.type === 'credentials');
    expect(credentialProviders).toHaveLength(0);
  });

  it('8.2.2.2 jwt 回调在 account 传入时正确映射 accessToken', async () => {
    const jwtCallback = authOptions.callbacks?.jwt;
    expect(jwtCallback).toBeDefined();
    if (jwtCallback) {
      const token = await jwtCallback({
        token: {},
        user: { id: 'test-user', email: 'test@example.com', name: 'Test' } as any,
        account: { access_token: 'gho_new_token', provider: 'github' } as any,
      });
      expect(token.accessToken).toBe('gho_new_token');
      expect(token.sub).toBe('test-user');
    }
  });
});
