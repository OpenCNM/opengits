import { describe, expect, it, beforeEach, vi } from 'vitest';
import { triggerGithubReauth } from '@/lib/import-wizard/wizard-reauth';
import { readPendingImportReauth, isReauthInCooldown } from '@/lib/stores/pending-import-reauth';
import { useImportWizardStore } from '@/lib/stores/import-wizard-store';

const mockSignIn = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

describe('triggerGithubReauth (Seamless OAuth Re-authentication)', () => {
  const mockStorage = new Map<string, string>();

  beforeEach(() => {
    mockStorage.clear();
    mockSignIn.mockClear();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => mockStorage.get(k) ?? null,
      setItem: (k: string, v: string) => mockStorage.set(k, String(v)),
      removeItem: (k: string) => mockStorage.delete(k),
      clear: () => mockStorage.clear(),
    });
    useImportWizardStore.setState({
      url: 'https://github.com/facebook/react',
      targetLanguage: 'zh-CN',
      createEdition: false,
      isPublic: true,
      importMode: 'github',
    });
  });

  it('自动暂存向导状态并唤起 signIn("github")', () => {
    triggerGithubReauth({ url: 'https://github.com/facebook/react' });

    // 验证向导状态已被持久化到 sessionStorage
    const restored = readPendingImportReauth();
    expect(restored).not.toBeNull();
    expect(restored?.url).toBe('https://github.com/facebook/react');
    expect(restored?.targetLanguage).toBe('zh-CN');

    // 验证冷却期已激活，防止死循环
    expect(isReauthInCooldown()).toBe(true);

    // 验证调用了 signIn 触发重定向
    expect(mockSignIn).toHaveBeenCalledWith('github', expect.objectContaining({
      callbackUrl: expect.any(String),
    }));
  });
});
