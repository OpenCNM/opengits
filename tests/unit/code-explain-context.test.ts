import { describe, expect, it } from 'vitest';
import {
  parseExplainCodePayload,
  serializeExplainCodePayload,
  buildExplainCodeSearchQuery,
  extractCodeExplainContext,
} from '@/lib/code-viewport/explain-context';
import { useModalStore } from '@/lib/stores/modal-store';

describe('code explain context & deep-dive store contract', () => {
  it('round-trips structured explain_code payload with full context metadata', () => {
    const serialized = serializeExplainCodePayload({
      code: 'class Neuron(Module):\n  pass',
      language: 'python',
      filePath: 'micrograd/nn.py',
      title: 'nn.py',
      sectionTitle: '神经元的前向计算',
      surroundingContext: '每个神经元维护权重向量 w 与偏置 b，并在非线性和线性模式间切换。',
      symbol: 'Neuron',
      lineRange: { startLine: 1, endLine: 16 },
      lineCount: 16,
    });

    const parsed = parseExplainCodePayload(serialized);
    expect(parsed).toEqual({
      code: 'class Neuron(Module):\n  pass',
      language: 'python',
      filePath: 'micrograd/nn.py',
      title: 'nn.py',
      sectionTitle: '神经元的前向计算',
      surroundingContext: '每个神经元维护权重向量 w 与偏置 b，并在非线性和线性模式间切换。',
      symbol: 'Neuron',
      lineRange: { startLine: 1, endLine: 16 },
      lineCount: 16,
    });
  });

  it('rejects non-explain_code messages and malformed JSON safely', () => {
    expect(parseExplainCodePayload('normal question')).toBeNull();
    expect(parseExplainCodePayload(JSON.stringify({ type: 'explain_selection', text: 'hello' }))).toBeNull();
    expect(parseExplainCodePayload(JSON.stringify({ type: 'explain_code', code: '   ' }))).toBeNull();
    expect(parseExplainCodePayload('{type: "explain_code"')).toBeNull();
  });

  it('builds compact semantic search query from metadata rather than JSON braces', () => {
    const search = buildExplainCodeSearchQuery({
      code: 'def __call__(self, x): return act.relu()',
      language: 'python',
      filePath: 'micrograd/nn.py',
      sectionTitle: 'Neuron 前向传播',
      symbol: 'Neuron',
      surroundingContext: 'zip 将输入向量和权重逐项配对求和。',
    });

    expect(search).toContain('Neuron 前向传播');
    expect(search).toContain('micrograd/nn.py');
    expect(search).toContain('Neuron');
    expect(search).not.toContain('{"type"');
  });

  it('focuses oversized drawer source files around target lineRange without dropping target code', () => {
    const lines = Array.from({ length: 320 }, (_, i) => `line_${i + 1} = ${i + 1}`);
    const context = extractCodeExplainContext({
      element: null,
      code: lines.join('\n'),
      language: 'python',
      filePath: 'micrograd/engine.py',
      lineCount: 320,
    });

    expect(context.filePath).toBe('micrograd/engine.py');
    expect(context.language).toBe('python');
    expect(context.code).toContain('line_1 = 1');
    expect(context.code).toContain('truncated (320 total lines)');
  });

  it('modal store triggerDeepDive accepts both legacy string and structured DeepDiveContext', () => {
    const store = useModalStore.getState();
    store.clearDeepDive();

    store.triggerDeepDive({
      code: 'class Neuron(Module): pass',
      language: 'python',
      sectionTitle: '多层感知机',
    });
    expect(useModalStore.getState().deepDivePayload?.code).toBe('class Neuron(Module): pass');
    expect(useModalStore.getState().deepDivePayload?.language).toBe('python');
    expect(useModalStore.getState().deepDivePayload?.sectionTitle).toBe('多层感知机');

    store.triggerDeepDive('const x = 1;');
    expect(useModalStore.getState().deepDivePayload?.code).toBe('const x = 1;');

    store.clearDeepDive();
    expect(useModalStore.getState().deepDivePayload).toBeNull();
  });
});
