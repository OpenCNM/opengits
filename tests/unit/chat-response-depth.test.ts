import { describe, expect, it } from 'vitest';
import { AGENT_DEFAULTS, DEFAULT_EXPLAIN_DEPTH } from '@/lib/constants';
import { extractStreamableAssistantText } from '@/lib/ai/unwrap-chat-response';
import {
  buildExplainDepthDirective,
  normalizeExplainDepth,
  stripLegacyResponseJsonInstruction,
} from '@/lib/ai/response-depth';

describe('extractStreamableAssistantText', () => {
  it('passes through regular Markdown untouched', () => {
    const md = '## 架构结论\n\n`Module` 只约束 `parameters()` 统一入口。';
    expect(extractStreamableAssistantText(md)).toBe(md);
  });

  it('unwraps complete {"response": "..."} JSON payloads with escapes and code fences', () => {
    const payload =
      '```json\n{"response": "好问题，我们看 **设计**\\n\\n## 核心原因\\n\\t1. 鸭子类型 \\"安全\\""}\n```';
    expect(extractStreamableAssistantText(payload)).toBe(
      '好问题，我们看 **设计**\n\n## 核心原因\n\t1. 鸭子类型 "安全"'
    );
  });

  it('decodes incremental streaming chunks without leaking trailing partial escapes', () => {
    expect(extractStreamableAssistantText('{"response": "第一行\\')).toBe('第一行');
    expect(extractStreamableAssistantText('{"response": "第一行\\n第二行\\u4e2')).toBe(
      '第一行\n第二行'
    );
    expect(extractStreamableAssistantText('{"response": "第一行\\n第二行\\u4e2d')).toBe(
      '第一行\n第二行中'
    );
  });
});

describe('response depth tiers (simple default + zero information loss)', () => {
  it('defaults AGENT_DEFAULTS.explainDepth to simple', () => {
    expect(DEFAULT_EXPLAIN_DEPTH).toBe('simple');
    expect(AGENT_DEFAULTS.explainDepth).toBe('simple');
  });

  it('normalizes valid and invalid depth values safely back to simple', () => {
    expect(normalizeExplainDepth(undefined)).toBe('simple');
    expect(normalizeExplainDepth('')).toBe('simple');
    expect(normalizeExplainDepth('unknown_tier')).toBe('simple');
    expect(normalizeExplainDepth('simple')).toBe('simple');
    expect(normalizeExplainDepth('normal')).toBe('normal');
    expect(normalizeExplainDepth('detailed')).toBe('detailed');
  });

  it('builds distinct tier directives while enforcing zero information loss', () => {
    const simplePrompt = buildExplainDepthDirective('simple');
    const normalPrompt = buildExplainDepthDirective('normal');
    const detailedPrompt = buildExplainDepthDirective('detailed');

    for (const directive of [simplePrompt, normalPrompt, detailedPrompt]) {
      expect(directive).toContain('ZERO INFORMATION LOSS');
      expect(directive).toContain('never wrap in JSON');
    }

    expect(simplePrompt).toContain('SIMPLE (简单模式 - DEFAULT)');
    expect(normalPrompt).toContain('NORMAL (正常模式)');
    expect(detailedPrompt).toContain('DETAILED (详细模式)');
  });

  it('strips legacy outputSchemaHint JSON-enforcement suffix from cached tutor prompts', () => {
    const legacyPrompt = [
      'You are an expert AI Assistant.',
      'RULES:\n- Reply clearly.',
      'Respond strictly with a JSON object matching this schema:\n```json\n{\n  "response": "example"\n}\n```',
    ].join('\n\n');

    const cleaned = stripLegacyResponseJsonInstruction(legacyPrompt);
    expect(cleaned).toBe('You are an expert AI Assistant.\n\nRULES:\n- Reply clearly.');
  });
});
