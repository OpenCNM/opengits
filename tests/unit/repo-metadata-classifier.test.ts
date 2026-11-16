import { test, expect, describe } from 'vitest';
import { z } from 'zod';
import { REPO_METADATA_CATEGORIES } from '@/lib/constants';
import { buildOutlineEvidence } from '@/lib/scout/pipeline/repo-metadata-classifier';

describe('REPO_METADATA_CATEGORIES（封闭词表 SSOT）', () => {
  test('11 值与 UI 领域选择器/打标注册表对齐', () => {
    expect(REPO_METADATA_CATEGORIES).toEqual([
      'AI', 'Systems', 'Cloud', 'Web', 'Mobile', 'Gaming',
      'Hardware', 'Finance', 'Science', 'Books', 'Others',
    ]);
  });
});

describe('buildOutlineEvidence（大纲证据表）', () => {
  test('章名|摘要|文件采样，摘要截断 80 字，封顶 20 章/章 4 文件', () => {
    const chapters = Array.from({ length: 25 }, (_, i) => ({
      name: `第 ${i + 1} 章: 测试章节`,
      summary: '摘要'.repeat(60),
      files: Array.from({ length: 8 }, (_, j) => ({ path: `src/mod-${i}/file-${j}.ts` })),
    }));
    const lines = buildOutlineEvidence(chapters).split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[0]).toContain('第 1 章: 测试章节');
    expect(lines[0]).toContain('摘要'.repeat(40));
    expect(lines[0]).toContain('src/mod-0/file-0.ts, src/mod-0/file-1.ts, src/mod-0/file-2.ts, src/mod-0/file-3.ts');
    expect(lines[0].split(' | ')[2].split(', ')).toHaveLength(4);
  });

  test('string 形态文件路径与缺省字段容错', () => {
    const evidence = buildOutlineEvidence([
      { name: '架构章', summary: '', files: ['pkg/core.go'] },
      { title: '无名列', files: [{ path: 'lib/x.py' }] },
      { name: '', summary: '无名章被跳过' },
    ]);
    const lines = evidence.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('架构章 |  | pkg/core.go');
    expect(lines[1]).toContain('无名列 |  | lib/x.py');
  });
});

describe('metadataSchema（封闭词表漏斗）', () => {
  // schema 未导出——此处用同源常量重建等价枚举校验词表行为契约
  const schema = z.object({
    category: z.enum(REPO_METADATA_CATEGORIES as [string, ...string[]]),
    tags: z.array(z.string().min(1).max(40)).min(1).max(6),
  });

  test('cline 形态判决（AI + 标签）通过', () => {
    const parsed = schema.safeParse({
      category: 'AI',
      tags: ['LLM-Agent', 'VSCode', 'MCP', 'TypeScript'],
    });
    expect(parsed.success).toBe(true);
  });

  test('词表外类目拒收（fail-open 兜底的前提）', () => {
    const parsed = schema.safeParse({ category: 'DevTools', tags: ['CLI'] });
    expect(parsed.success).toBe(false);
  });

  test('空标签数组拒收', () => {
    const parsed = schema.safeParse({ category: 'Web', tags: [] });
    expect(parsed.success).toBe(false);
  });
});
