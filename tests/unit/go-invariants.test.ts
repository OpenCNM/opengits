import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { execSync } from 'node:child_process';

describe('Go Sidecar Physical Invariants Integrity', () => {
  const rootDir = path.resolve(__dirname, '../..');

  it('should pass all Go static physical invariant guardrails with zero violations', () => {
    const output = execSync('node scripts/lint-go-invariants.mjs', {
      cwd: rootDir,
      encoding: 'utf-8',
    });

    expect(output).toContain('✅ Go 物理不变式门禁通过，0 项违规！');
  });
});
