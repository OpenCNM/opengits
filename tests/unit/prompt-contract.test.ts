import { describe, expect, it } from 'vitest';
import { PROMPT_REQUIRED_MARKERS, validatePromptContract } from '@/lib/prompt-contract';
import type { PromptSchemaDefinition } from '@/lib/prompt-registry';

const schemaWithMarker = (marker: string): PromptSchemaDefinition => ({
  role: 'You are a repair assistant.',
  taskDescription: `Fix the MDX source.\n\nOUTPUT FORMAT: You MUST begin your output with the exact marker: ${marker}`,
  rules: ['Keep everything else byte-identical.'],
  language: 'zh-CN',
});

const schemaWithoutMarker = (): PromptSchemaDefinition => ({
  role: 'You are a repair assistant.',
  taskDescription: 'Fix the MDX source. (output-format instruction was removed by mistake)',
  rules: ['Keep everything else byte-identical.'],
  language: 'zh-CN',
});

describe('validatePromptContract', () => {
  it.each(Object.keys(PROMPT_REQUIRED_MARKERS))('已登记 key "%s" 保留全部标记时通过', (key) => {
    const violations = validatePromptContract(key, schemaWithMarker(PROMPT_REQUIRED_MARKERS[key].join('\n')));
    expect(violations).toEqual([]);
  });

  it.each(Object.keys(PROMPT_REQUIRED_MARKERS))(
    '已登记 key "%s" 缺失标记时返回带标记名的违例',
    (key) => {
      const markers = PROMPT_REQUIRED_MARKERS[key];
      const violations = validatePromptContract(key, schemaWithoutMarker());
      expect(violations).toHaveLength(markers.length);
      for (const marker of markers) {
        expect(violations.some((v) => v.includes(key) && v.includes(marker))).toBe(true);
      }
    }
  );

  it('多标记 key 缺失任一标记即拒绝（mdx_enhancer 缺 pedagogy_manifest）', () => {
    const violations = validatePromptContract(
      'mdx_enhancer',
      schemaWithMarker('===CONTENT_BEGIN===')
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('<pedagogy_manifest>');
  });

  it('标记藏在 rules 中同样视为保留（taskDescription 与 rules 拼接校验）', () => {
    const schema: PromptSchemaDefinition = {
      role: 'r',
      taskDescription: 'plain description',
      rules: ['OUTPUT: begin with ===CONTENT_BEGIN==='],
      language: 'zh-CN',
    };
    expect(validatePromptContract('mdx_repair', schema)).toEqual([]);
  });

  it('未登记 key 不做契约约束（自由编辑不受阻塞）', () => {
    expect(validatePromptContract('quiz_generation', schemaWithoutMarker())).toEqual([]);
  });
});
