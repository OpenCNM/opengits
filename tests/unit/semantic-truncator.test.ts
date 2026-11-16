import { describe, it, expect } from 'vitest';
import {
  truncateCognitiveBudget,
  DEFAULT_TRUNCATE_SUFFIX,
} from '@/lib/agent/semantic-truncator';
import { estimateTokens } from '@/lib/token-counter';

describe('truncateCognitiveBudget: 确定性语义截断与围栏自愈', () => {
  it('预算内文本原样返回，不截断', () => {
    const text = '这是简短的内容，不会超限。';
    const res = truncateCognitiveBudget(text, { maxTokens: 100 });
    expect(res.truncated).toBe(false);
    expect(res.text).toBe(text);
    expect(res.closedFences).toHaveLength(0);
  });

  it('非法或 0 预算安全返回空串或后缀', () => {
    expect(truncateCognitiveBudget('', { maxTokens: 50 }).text).toBe('');
    expect(truncateCognitiveBudget('text', { maxTokens: 0 }).text).toBe('');
    expect(truncateCognitiveBudget('text', { maxTokens: -1 }).text).toBe('');
  });

  it('未闭合三反引号代码块 (```ts) 截断后 100% 自动闭合', () => {
    const codeMarkdown = [
      '```typescript',
      'export function processData(input: string) {',
      '  const step1 = input.trim();',
      '  const step2 = step1.toUpperCase();',
      '  const step3 = step2.toLowerCase();',
      '  const step4 = step3.concat(" MORE CODE LINES");',
      '  const step5 = step4.split(" ");',
      '  return step5.join("-");',
      '}',
    ].join('\n');

    const res = truncateCognitiveBudget(codeMarkdown, { maxTokens: 25 });
    expect(res.truncated).toBe(true);

    // 验证所有反引号代码栅栏成对闭合
    const fences = res.text.match(/^[ \t]{0,3}(`{3,}|~{3,})/gm) || [];
    expect(fences.length % 2).toBe(0);
    expect(res.closedFences).toContain('```');
    expect(res.text).toContain('... [Content truncated to fit cognitive budget]');
  });

  it('未闭合波浪号代码块 (~~~bash) 截断后以匹配的 ~~~ 闭合', () => {
    const tildeMarkdown = [
      '启动服务：',
      '~~~bash',
      'npm install',
      'npm run build',
      'npm run start',
    ].join('\n');

    const res = truncateCognitiveBudget(tildeMarkdown, { maxTokens: 15 });
    expect(res.truncated).toBe(true);

    const fences = res.text.match(/^[ \t]{0,3}(`{3,}|~{3,})/gm) || [];
    expect(fences.length % 2).toBe(0);
    expect(res.closedFences).toContain('~~~');
  });

  it('未闭合行内单反引号自动补齐闭合', () => {
    const inlineCode = '在 JavaScript 中调用 `const result = compute()';
    const res = truncateCognitiveBudget(inlineCode, { maxChars: 30 });
    expect(res.truncated).toBe(true);

    // 统计文本中单反引号总数必须为偶数
    const singleBackticks = res.text.replace(/`{2,}/g, '').match(/`/g) || [];
    expect(singleBackticks.length % 2).toBe(0);
  });

  it('未闭合 HTML 注释自动补齐 -->', () => {
    const htmlComment = '段落一 <!-- 这里是一段很长很长的未闭合 HTML 注释，' + '说明'.repeat(100);
    const res = truncateCognitiveBudget(htmlComment, { maxTokens: 20 });
    expect(res.truncated).toBe(true);
    expect(res.text).toContain('-->');
  });

  it('优先在段落边界 (\\n\\n) 或换行处切分，不切碎中间文字', () => {
    const paragraphText = [
      '这是第一段详细描述，包含重要的背景事实。',
      '',
      '这是第二段核心要点，讲解主要的设计架构与权衡。',
      '',
      '这是第三段后续说明，' + '补充文本。'.repeat(100),
    ].join('\n');

    const res = truncateCognitiveBudget(paragraphText, { maxTokens: 40 });
    expect(res.truncated).toBe(true);
    // 应该在第一段或第二段结束处干净切断，而不是在段落正中
    expect(res.text).toContain('这是第一段详细描述');
    expect(res.finalTokens).toBeLessThanOrEqual(50);
  });

  it('emoji 代理对与高位 Unicode 字符安全切片，无孤立代理半区', () => {
    const emojiText = '🚀🔥🎉✨'.repeat(20) + '文字'.repeat(100);
    const res = truncateCognitiveBudget(emojiText, { maxTokens: 25 });
    expect(res.truncated).toBe(true);

    for (const ch of res.text) {
      const code = ch.codePointAt(0)!;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });

});
