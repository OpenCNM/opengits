import { describe, it, expect } from 'vitest';
import robots from '@/app/robots';

describe('M09 [9.2] SEO Robots & Sitemap Rules', () => {
  it('9.2.1.1 robots 规则严格屏蔽敏感路由', () => {
    const config = robots();
    expect(config.rules).toBeDefined();
    const rules = Array.isArray(config.rules) ? config.rules[0] : config.rules;
    expect(rules.disallow).toContain('/admin/');
    expect(rules.disallow).toContain('/api/');
    expect(rules.disallow).toContain('/settings/');
  });
});
