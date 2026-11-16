import { test, expect, describe } from 'vitest';
import { sanitizeMermaid } from '@/lib/mermaid/resilience';

describe('mermaid resilience: sanitizeMermaid 拓扑清洗与语法兼容', () => {
  test('兼容 graph TD 与 flowchart TD，剥离前置文字与代码围栏', () => {
    const rawTd = `以下是系统架构拓扑：
\`\`\`mermaid
graph TD
  Entry["System Entry"] --> Core["Core Engine"]
\`\`\``;

    const cleaned = sanitizeMermaid(rawTd);
    expect(cleaned).toContain('graph TD');
    expect(cleaned).toContain('Entry["System Entry"] --> Core["Core Engine"]');
    expect(cleaned).not.toContain('以下是系统架构拓扑');
    expect(cleaned).not.toContain('```');
  });

  test('兼容 flowchart LR 与 graph LR', () => {
    const rawLr = `Here is the diagram:
flowchart LR
  A --> B`;
    const cleaned = sanitizeMermaid(rawLr);
    expect(cleaned).toBe('flowchart LR\n  A --> B');
  });

  test('兼容缺省方向的 graph 与 flowchart 语法', () => {
    const rawNoDir = `Diagram:
graph
  A["Start"] --> B["End"]`;
    const cleaned = sanitizeMermaid(rawNoDir);
    expect(cleaned).toBe('graph\n  A["Start"] --> B["End"]');

    const flowNoDir = `Diagram:\nflowchart\n  X --> Y`;
    expect(sanitizeMermaid(flowNoDir)).toBe('flowchart\n  X --> Y');
  });

  test('彻底剥除 LLM 思考块 <think> 与 <thought>', () => {
    const rawWithThink = `<think>
I should generate a graph TD for the user.
Step 1 is entry, Step 2 is process.
</think>
\`\`\`mermaid
graph TD
  A[Start] --> B[End]
\`\`\``;
    const cleaned = sanitizeMermaid(rawWithThink);
    expect(cleaned).not.toContain('<think>');
    expect(cleaned).not.toContain('I should generate');
    expect(cleaned).toBe('graph TD\n  A[Start] --> B[End]');

    const rawWithThought = `<thought>Let us structure the diagram</thought>
flowchart TD
  Node1 --> Node2`;
    expect(sanitizeMermaid(rawWithThought)).toBe('flowchart TD\n  Node1 --> Node2');
  });

  test('确定性扫描自愈特殊字符标签并防止 Gall 补丁超限', () => {
    const rawSpecial = `graph TD
  A[Port: 8080 (HTTP) & TLS] --> B[Ratio > 50% / Valid]`;
    const cleaned = sanitizeMermaid(rawSpecial);
    expect(cleaned).toContain('A[Port: 8080 (HTTP) & TLS]');
    expect(cleaned).toContain('B[Ratio > 50% / Valid]');
  });

  test('正确追踪括号/方括号嵌套深度，杜绝提前截断破坏语法', () => {
    const rawNested = `graph TD
  A(Hello (Nested 1) and (Nested 2)) --> B[Items: [0] and [1]]`;
    const cleaned = sanitizeMermaid(rawNested);
    expect(cleaned).toBe('graph TD\n  A(Hello (Nested 1) and (Nested 2)) --> B[Items: [0] and [1]]');
  });

  test('支持全 CJK 字符集（日文片假名/平假名/韩文谚文）作为节点 ID', () => {
    const rawCjk = `graph TD
  サーバー[Port: 8080] --> クライアント[Port: 3000]`;
    const cleaned = sanitizeMermaid(rawCjk);
    expect(cleaned).toBe('graph TD\n  サーバー[Port: 8080] --> クライアント[Port: 3000]');
  });

  test('兼容节点 ID 与形状开括号之间的空格，并保留已有转义双引号', () => {
    const raw = `graph TD
  A [Port: 8080] --> B["foo (bar) \\"baz\\""]`;
    const cleaned = sanitizeMermaid(raw);
    expect(cleaned).toBe('graph TD\n  A [Port: 8080] --> B["foo (bar) \\"baz\\""]');
  });
});
