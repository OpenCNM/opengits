import { describe, it, expect, beforeEach } from 'vitest';
import {
  __setPoolForTests,
  acquirePoolToken,
  markTokenQuarantined,
  isTokenQuarantined,
  poolStats,
  tokenFingerprint,
} from '@/lib/github/token-pool';

describe('GitHub Token Pool 401 Quarantine (A5)', () => {
  beforeEach(() => {
    __setPoolForTests([
      { value: 'ghp_token_alpha_111' },
      { value: 'ghp_token_beta_222' },
      { value: 'ghp_token_gamma_333' },
    ]);
  });

  it('skips quarantined token when acquiring pool token and updates poolStats', () => {
    const token1 = acquirePoolToken()!;
    expect(token1).toBeDefined();
    const fp1 = token1.fingerprint;

    // Initially all 3 are healthy
    expect(poolStats()).toEqual({ size: 3, healthy: 3, quarantined: 0 });

    // Mark token 1 quarantined (simulating 401 Unauthorized)
    markTokenQuarantined(fp1);

    expect(isTokenQuarantined(fp1)).toBe(true);
    expect(poolStats()).toEqual({ size: 3, healthy: 2, quarantined: 1 });

    // Subsequent acquires should only return token 2 and 3, never token 1
    const acquiredTokens = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const t = acquirePoolToken();
      if (t) acquiredTokens.add(t.value);
    }

    expect(acquiredTokens.has(token1.value)).toBe(false);
    expect(acquiredTokens.has('ghp_token_beta_222')).toBe(true);
    expect(acquiredTokens.has('ghp_token_gamma_333')).toBe(true);
  });

  it('returns undefined when all tokens in pool are quarantined', () => {
    const fp1 = tokenFingerprint('ghp_token_alpha_111');
    const fp2 = tokenFingerprint('ghp_token_beta_222');
    const fp3 = tokenFingerprint('ghp_token_gamma_333');

    markTokenQuarantined(fp1);
    markTokenQuarantined(fp2);
    markTokenQuarantined(fp3);

    expect(poolStats()).toEqual({ size: 3, healthy: 0, quarantined: 3 });
    expect(acquirePoolToken()).toBeUndefined();
  });
});
