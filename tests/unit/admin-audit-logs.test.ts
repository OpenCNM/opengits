import { describe, it, expect } from 'vitest';
import { ENGINE_CONFIG } from '@/lib/config';

describe('M10 [10.3] Admin Audit Logs & Quota Dashboard', () => {
  it('10.3.1.1 审计日志分页默认与最大限制配置有效', () => {
    expect(ENGINE_CONFIG.pagination.adminDefault).toBe(100);
    expect(ENGINE_CONFIG.pagination.adminTelemetry).toBeGreaterThanOrEqual(ENGINE_CONFIG.pagination.adminDefault);
  });
});
