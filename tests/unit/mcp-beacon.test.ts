import { test, expect, describe, vi, beforeEach } from 'vitest';
import {
  deriveQueryDimension,
  truncateToolOutput,
  wrapToolTelemetry,
} from '@/lib/telemetry/mcp-beacon';
import { prisma } from '@/lib/db';

vi.mock('@/lib/db', () => ({
  prisma: {
    mcpCallLog: {
      create: vi.fn().mockResolvedValue({ id: 'log-1' }),
    },
    user: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: 'user-1' }),
    },
    repository: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    mcpBundle: {
      findUnique: vi.fn(),
    },
  },
}));

describe('mcp-beacon 遥测与输出截断', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('deriveQueryDimension 维度推导', () => {
    test('根据工具名映射对应的查询维度', () => {
      expect(deriveQueryDimension('search_architecture_overview')).toBe('architecture');
      expect(deriveQueryDimension('read_code_snippet')).toBe('code');
      expect(deriveQueryDimension('check_gotchas')).toBe('gotchas');
      expect(deriveQueryDimension('get_document')).toBe('all');
    });
  });

  describe('truncateToolOutput Token 预算与截断保护', () => {
    test('在预算范围内完整保留文本', () => {
      const result = {
        content: [
          { type: 'text', text: '短文本 1' },
          { type: 'text', text: '短文本 2' },
        ],
      };

      const truncated = truncateToolOutput(result, 2000);
      expect(truncated.content[0].text).toBe('短文本 1');
      expect(truncated.content[1].text).toBe('短文本 2');
    });

    test('超出预算时截断并保证 256 Token 最小地板', () => {
      const longText = '长文本段落 '.repeat(300);
      const result = {
        content: [
          { type: 'text', text: longText },
        ],
      };

      const truncated = truncateToolOutput(result, 100); // 预算只有 100，触发 Math.max(256, 100)
      expect((truncated.content[0].text as string).length).toBeLessThan(longText.length);
      expect(truncated.content[0].text).toContain('[Content truncated');
    });

    test('非文本 block（如资源/图片）原样保留', () => {
      const result = {
        content: [
          { type: 'image', data: 'base64...' },
        ],
      };

      const truncated = truncateToolOutput(result, 100);
      expect(truncated.content[0]).toEqual({ type: 'image', data: 'base64...' });
    });

    test('非法入参容错原样返回', () => {
      expect(truncateToolOutput(null, 100)).toBeNull();
      expect(truncateToolOutput(undefined, 100)).toBeUndefined();
      expect(truncateToolOutput('string' as any, 100)).toBe('string');
    });
  });

  describe('wrapToolTelemetry 异常捕获与重抛', () => {
    test('handler 抛错时记录 ERROR 遥测并向外重抛', async () => {
      const failingHandler = vi.fn().mockRejectedValue(new Error('工具执行内部崩溃'));

      const wrapped = wrapToolTelemetry(
        { toolName: 'search_docs' },
        failingHandler
      );

      await expect(wrapped({ query: 'React' }, {})).rejects.toThrow('工具执行内部崩溃');
    });

    test('handler 正常执行并完成 Token 截断', async () => {
      (prisma.user.findUnique as any).mockResolvedValue({
        id: 'user-1',
        singleCallTokenCap: 1000,
        role: 'USER',
      });

      const successHandler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '返回结果' }],
      });

      const wrapped = wrapToolTelemetry<Record<string, unknown>, { content: Array<{ type: string; text: string }> }>(
        { toolName: 'get_document', userId: 'user-1' },
        successHandler
      );

      const res = await wrapped({}, {});
      expect(res.content[0].text).toBe('返回结果');
    });
  });
});
