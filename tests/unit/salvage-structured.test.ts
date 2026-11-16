import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  fastSalvageJson,
  salvageOrRepairStructured,
} from '@/lib/ai/salvage-structured';

const sampleQuizSchema = z.object({
  quizzes: z.array(
    z.object({
      question: z.string(),
      options: z.array(z.string()).length(4),
      correctIndex: z.number().min(0).max(3),
      explanation: z.string(),
    })
  ).min(1),
});

describe('fastSalvageJson (0ms 纯确定性快速拆包与自愈)', () => {
  it('标准 JSON 对象 0ms 瞬间通过', () => {
    const raw = JSON.stringify({
      quizzes: [
        {
          question: '什么是 AST？',
          options: ['抽象语法树', '自动测试脚本', '异步传输协议', '应用状态树'],
          correctIndex: 0,
          explanation: 'AST 是抽象语法树。',
        },
      ],
    });

    const result = fastSalvageJson(raw, sampleQuizSchema);
    expect(result).not.toBeNull();
    expect(result?.quizzes[0].question).toBe('什么是 AST？');
  });

  it('剥离 <think> 思考链外壳与内部杂音', () => {
    const raw = `<think>
用户想要一道关于 AST 的题目。
我需要确保生成 { "quizzes": [...] } 格式。
首先设计第一题...
</think>
{
  "quizzes": [
    {
      "question": "什么是 AST？",
      "options": ["抽象语法树", "自动测试脚本", "异步传输协议", "应用状态树"],
      "correctIndex": 0,
      "explanation": "AST 是抽象语法树。"
    }
  ]
}`;

    const result = fastSalvageJson(raw, sampleQuizSchema);
    expect(result).not.toBeNull();
    expect(result?.quizzes).toHaveLength(1);
    expect(result?.quizzes[0].question).toBe('什么是 AST？');
  });

  it('剥离 Markdown 代码块 ```json 围栏', () => {
    const raw = `\`\`\`json
{
  "quizzes": [
    {
      "question": "什么是 AST？",
      "options": ["抽象语法树", "自动测试脚本", "异步传输协议", "应用状态树"],
      "correctIndex": 0,
      "explanation": "AST 是抽象语法树。"
    }
  ]
}
\`\`\``;

    const result = fastSalvageJson(raw, sampleQuizSchema);
    expect(result).not.toBeNull();
    expect(result?.quizzes).toHaveLength(1);
  });

  it('自动修剪尾部悬挂非法逗号', () => {
    const raw = `{
  "quizzes": [
    {
      "question": "什么是 AST？",
      "options": ["抽象语法树", "自动测试脚本", "异步传输协议", "应用状态树",],
      "correctIndex": 0,
      "explanation": "AST 是抽象语法树。",
    },
  ],
}`;

    const result = fastSalvageJson(raw, sampleQuizSchema);
    expect(result).not.toBeNull();
    expect(result?.quizzes[0].options).toHaveLength(4);
  });

  it('因 token 截断未闭合括号时自动补齐闭合', () => {
    // 结尾被截断，缺少 "}]}"
    const raw = `{
  "quizzes": [
    {
      "question": "什么是 AST？",
      "options": ["抽象语法树", "自动测试脚本", "异步传输协议", "应用状态树"],
      "correctIndex": 0,
      "explanation": "AST 是抽象语法树。"`;

    const result = fastSalvageJson(raw, sampleQuizSchema);
    expect(result).not.toBeNull();
    expect(result?.quizzes[0].question).toBe('什么是 AST？');
  });

  it('大模型直接输出顶层数组时宽容包装为 { quizzes: [...] }', () => {
    const raw = `[
    {
      "question": "什么是 AST？",
      "options": ["抽象语法树", "自动测试脚本", "异步传输协议", "应用状态树"],
      "correctIndex": 0,
      "explanation": "AST 是抽象语法树。"
    }
]`;

    const result = fastSalvageJson(raw, sampleQuizSchema);
    expect(result).not.toBeNull();
    expect(result?.quizzes).toHaveLength(1);
  });

  it('大模型输出 1-based correctIndex 时自动校正为 0-based', () => {
    const raw = `{
  "quizzes": [
    {
      "question": "什么是 AST？",
      "options": ["A", "B", "C", "D"],
      "correctIndex": 4,
      "explanation": "D 是正确的。"
    }
  ]
}`;

    const result = fastSalvageJson(raw, sampleQuizSchema);
    expect(result).not.toBeNull();
    expect(result?.quizzes[0].correctIndex).toBe(3);
  });
});

function makeFakeModel(text: string) {
  return {
    specificationVersion: 'v4',
    provider: 'test-fake',
    modelId: 'fake',
    doGenerate: async () => {
      return {
        content: [{ type: 'text', text }],
        text,
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, noCache: 1 },
          totalTokens: { total: 2 },
        },
        finishReason: { unified: 'stop' },
        response: { id: 'fake-response', modelId: 'fake', timestamp: new Date() },
        warnings: [],
        rawCallResponse: {},
      };
    },
  } as any;
}

describe('salvageOrRepairStructured (两级协同自愈统一入口)', () => {
  it('0ms 快路径救活时优先返回 fast_salvage', async () => {
    const raw = '```json\n{"quizzes":[{"question":"Q","options":["1","2","3","4"],"correctIndex":0,"explanation":"E"}]}\n```';
    const res = await salvageOrRepairStructured(raw, sampleQuizSchema);
    expect(res).not.toBeNull();
    expect(res?.tier).toBe('fast_salvage');
    expect(res?.data.quizzes[0].question).toBe('Q');
  });

  it('快路径无法解析的深层语法破损降级触发 LLM 慢路径修复', async () => {
    // 属性中存在未转义换行或破损内部引号
    const broken = '{"quizzes": [{"question": "Q"with broken quote, "options": ["1","2","3","4"], "correctIndex": 0, "explanation": "E"}]}';

    const fakeModel = makeFakeModel('{"quizzes":[{"question":"Q with repaired quote","options":["1","2","3","4"],"correctIndex":0,"explanation":"E"}]}');

    const res = await salvageOrRepairStructured(broken, sampleQuizSchema, {
      model: fakeModel,
    });

    expect(res).not.toBeNull();
    expect(res?.tier).toBe('llm_repair');
    expect(res?.data.quizzes[0].question).toBe('Q with repaired quote');
  });

  it('彻底无法恢复的垃圾数据坚决失效封闭返回 null', async () => {
    const garbage = '彻底无法解析的胡言乱语';
    const fakeFailingModel = makeFakeModel('仍然是胡言乱语');

    const res = await salvageOrRepairStructured(garbage, sampleQuizSchema, {
      model: fakeFailingModel,
    });

    expect(res).toBeNull();
  });
});
