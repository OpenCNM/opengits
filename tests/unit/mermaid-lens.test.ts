import { describe, it, expect } from 'vitest';
import { ensureQuotedMermaidLabels } from '@/lib/mermaid/resilience';
import { hashDiagramSource } from '@/components/mdx/Mermaid';

describe('Mermaid Lens Utilities & Label Quoting Hardening', () => {
  describe('hashDiagramSource', () => {
    it('produces deterministic hashes for the same diagram code', () => {
      const code = 'flowchart TD\n  A --> B';
      const hash1 = hashDiagramSource(code);
      const hash2 = hashDiagramSource(code);
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe('string');
      expect(hash1.length).toBeGreaterThan(0);
    });

    it('produces different hashes for different diagram codes', () => {
      const code1 = 'flowchart TD\n  A --> B';
      const code2 = 'flowchart LR\n  A --> B';
      expect(hashDiagramSource(code1)).not.toBe(hashDiagramSource(code2));
    });

    it('normalizes CRLF and LF to produce identical hashes', () => {
      const codeCRLF = 'flowchart TD\r\n  A --> B\r\n';
      const codeLF = 'flowchart TD\n  A --> B\n';
      expect(hashDiagramSource(codeCRLF)).toBe(hashDiagramSource(codeLF));
    });

    it('handles empty or null-like input gracefully', () => {
      expect(hashDiagramSource('')).toBe('0');
      expect(hashDiagramSource(null as unknown as string)).toBe('0');
      expect(hashDiagramSource(undefined as unknown as string)).toBe('0');
    });
  });

  describe('ensureQuotedMermaidLabels', () => {
    it('quotes box labels containing colons, brackets, or parentheses', () => {
      const input = `flowchart LR
  client[Client: Browser (Chrome)] --> gateway[API: Gateway]
  gateway --> service[Auth Service (v2)]`;
      const output = ensureQuotedMermaidLabels(input);
      expect(output).toContain('client["Client: Browser (Chrome)"]');
      expect(output).toContain('gateway["API: Gateway"]');
      expect(output).toContain('service["Auth Service (v2)"]');
    });

    it('quotes cylinder and stadium labels containing special characters', () => {
      const input = `flowchart TD
  db[(Postgres: primary (5432))]
  api([REST Endpoint: /api/v1])`;
      const output = ensureQuotedMermaidLabels(input);
      expect(output).toContain('db[("Postgres: primary (5432)")]');
      expect(output).toContain('api(["REST Endpoint: /api/v1"])');
    });

    it('quotes double circle labels with exactly 3 parentheses and handles multiple on one line', () => {
      const single = `flowchart LR
  node(((Double Circle: test)))`;
      const singleOutput = ensureQuotedMermaidLabels(single);
      expect(singleOutput).toContain('node((("Double Circle: test")))');
      expect(singleOutput).not.toContain('((((');
      expect(singleOutput).not.toContain('))))');

      const multi = `flowchart LR
  node1(((Double 1: foo))) --> node2(((Double 2: bar)))`;
      const multiOutput = ensureQuotedMermaidLabels(multi);
      expect(multiOutput).toContain('node1((("Double 1: foo")))');
      expect(multiOutput).toContain('node2((("Double 2: bar")))');
      expect(multiOutput).not.toContain('((((');
    });

    it('quotes rounded nodes with nested balanced parentheses', () => {
      const input = `flowchart LR
  client(Client (Web Browser): v1) --> server(API Server (Express): v2)`;
      const output = ensureQuotedMermaidLabels(input);
      expect(output).toContain('client("Client (Web Browser): v1")');
      expect(output).toContain('server("API Server (Express): v2")');
    });

    it('quotes box nodes with nested balanced square brackets', () => {
      const input = `flowchart LR
  box[Box [Nested Tag]: v1] --> next[Simple: Node]`;
      const output = ensureQuotedMermaidLabels(input);
      expect(output).toContain('box["Box [Nested Tag]: v1"]');
      expect(output).toContain('next["Simple: Node"]');
    });

    it('quotes multiple distinct node shapes on the same line correctly', () => {
      const input = `flowchart LR
  A[Client: Web] --> B(Server: API) --> C((DB: SQL))`;
      const output = ensureQuotedMermaidLabels(input);
      expect(output).toBe(`flowchart LR\n  A["Client: Web"] --> B("Server: API") --> C(("DB: SQL"))`);
    });

    it('quotes subroutine, hexagon, circle, and rhombus labels', () => {
      const input = `flowchart LR
  worker[[Worker: Job Queue]]
  cond{{Condition: count > 0}}
  circ((Node: Start (001)))
  dec{Decision: Is Valid?}`;
      const output = ensureQuotedMermaidLabels(input);
      expect(output).toContain('worker[["Worker: Job Queue"]]');
      expect(output).toContain('cond{{"Condition: count > 0"}}');
      expect(output).toContain('circ(("Node: Start (001)"))');
      expect(output).toContain('dec{"Decision: Is Valid?"}');
    });

    it('quotes subgraph headers with square brackets', () => {
      const input = `flowchart TD
subgraph Core [Core Engine: Parser (v1)]
  A --> B
end`;
      const output = ensureQuotedMermaidLabels(input);
      expect(output).toContain('subgraph Core ["Core Engine: Parser (v1)"]');
    });

    it('quotes edge labels containing colons or parentheses', () => {
      const input = `flowchart LR
  A -->|Payload: JSON (v1)| B`;
      const output = ensureQuotedMermaidLabels(input);
      expect(output).toContain('A -->|"Payload: JSON (v1)"| B');
    });

    it('leaves already double-quoted labels untouched without double-wrapping', () => {
      const input = `flowchart LR
  A["Already: Quoted (Clean)"] --> B[("Already: DB")]`;
      const output = ensureQuotedMermaidLabels(input);
      expect(output).toBe(input);
    });

    it('leaves simple labels without special characters untouched', () => {
      const input = `flowchart LR
  A[Start] --> B[Process] --> C[End]`;
      const output = ensureQuotedMermaidLabels(input);
      expect(output).toBe(input);
    });

    it('preserves comments and keyword lines intact', () => {
      const input = `%% This is a comment: note (test)
flowchart LR
  classDef default fill:none
  style A stroke:#333
  direction TB
  A --> B
  end`;
      const output = ensureQuotedMermaidLabels(input);
      expect(output).toContain('%% This is a comment: note (test)');
      expect(output).toContain('classDef default fill:none');
      expect(output).toContain('style A stroke:#333');
    });

    it('handles empty string safely', () => {
      expect(ensureQuotedMermaidLabels('')).toBe('');
      expect(ensureQuotedMermaidLabels(null as unknown as string)).toBe('');
    });
  });
});
