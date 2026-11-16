import { describe, it, expect } from 'vitest';
import * as m from '@/paraglide/messages';

describe('M09 [9.3] Paraglide i18n & Theme Token Architecture', () => {
  it('9.3.1.1 Inlang Paraglide 编译期消息导出完整有效', () => {
    expect(typeof m.theme_dark).toBe('function');
    expect(typeof m.theme_light).toBe('function');
  });

  it('9.3.2.1 多语言消息在当前 locale 下正常返回字符串', () => {
    const darkLabel = m.theme_dark();
    expect(typeof darkLabel).toBe('string');
    expect(darkLabel.length).toBeGreaterThan(0);
  });
});
