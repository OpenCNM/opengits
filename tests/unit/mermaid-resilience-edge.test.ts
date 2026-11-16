import { describe, it, expect } from 'vitest';
import { sanitizeMermaid } from '@/lib/mermaid/resilience';
import { stripMermaidDangerousHtml } from '@/lib/mermaid/xss-guard';

describe('mermaid-resilience and xss-guard edge hardening', () => {
  describe('Preamble stripping for various diagram types', () => {
    it('strips conversational preamble before sequenceDiagram', () => {
      const raw = `Here is the sequence diagram illustrating the flow:
\`\`\`mermaid
sequenceDiagram
  Alice->>Bob: Hello
\`\`\``;
      const cleaned = sanitizeMermaid(raw);
      expect(cleaned).toContain('sequenceDiagram');
      expect(cleaned).toContain('Alice->>Bob: Hello');
      expect(cleaned).not.toContain('Here is the sequence diagram');
    });

    it('strips preamble before classDiagram and stateDiagram', () => {
      const classRaw = `Class diagram below:
classDiagram
  class Animal { +String name }`;
      expect(sanitizeMermaid(classRaw)).toBe('classDiagram\n  class Animal { +String name }');

      const stateRaw = `State machine below:
stateDiagram-v2
  [*] --> Still`;
      expect(sanitizeMermaid(stateRaw)).toBe('stateDiagram-v2\n  [*] --> Still');
    });

    it('strips preamble before erDiagram and mindmap', () => {
      const erRaw = `ER Schema:
erDiagram
  USER ||--o{ ORDER : places`;
      expect(sanitizeMermaid(erRaw)).toBe('erDiagram\n  USER ||--o{ ORDER : places');

      const mindRaw = `Mindmap:
mindmap
  root((Root))`;
      expect(sanitizeMermaid(mindRaw)).toBe('mindmap\n  root((Root))');
    });
  });


  describe('stripMermaidDangerousHtml XSS defense', () => {
    it('strips self-closing script tags as well as paired script tags', () => {
      const selfClosing = 'A["<script src=evil.js />Legit"]';
      const paired = 'B["<script>alert(1)</script>Safe"]';

      expect(stripMermaidDangerousHtml(selfClosing)).not.toContain('<script');
      expect(stripMermaidDangerousHtml(paired)).not.toContain('<script');
    });

    it('strips embedded iframe, object, and embed containers', () => {
      const iframe = 'A["<iframe src=\\"https://evil.com\\"></iframe>Hi"]';
      const object = 'B["<object data=\\"evil.swf\\"></object>Hello"]';
      const embed = 'C["<embed src=\\"evil.pdf\\" />World"]';

      expect(stripMermaidDangerousHtml(iframe)).not.toContain('<iframe');
      expect(stripMermaidDangerousHtml(object)).not.toContain('<object');
      expect(stripMermaidDangerousHtml(embed)).not.toContain('<embed');
    });

    it('strips event handlers even with atypical spacing like <svg/onload=alert(1)>', () => {
      const svg = 'A["<svg/onload=alert(1)>Label"]';
      const button = 'B["<button onclick=\\"alert(1)\\">Click</button>"]';

      expect(stripMermaidDangerousHtml(svg)).not.toContain('onload');
      expect(stripMermaidDangerousHtml(button)).not.toContain('onclick');
    });

    it('neutralizes javascript:, vbscript:, and data:text/html protocol attributes with nested quotes without orphan remnants', () => {
      const jsLink = 'A["<a href=\\"javascript:alert(\'XSS\')\\">Click</a>"]';
      const vbLink = 'B["<a href=\\"vbscript:msgbox(1)\\">Click</a>"]';
      const dataLink = 'C["<a href=\\"data:text/html,<script>alert(1)</script>\\">Click</a>"]';
      const nestedOnload = 'D["<img src=x onload=\\"alert(\'XSS\')\\">"]';

      expect(stripMermaidDangerousHtml(jsLink)).toBe('A["<a href=\\"\\">Click</a>"]');
      expect(stripMermaidDangerousHtml(vbLink)).toBe('B["<a href=\\"\\">Click</a>"]');
      expect(stripMermaidDangerousHtml(dataLink)).toBe('C["<a href=\\"\\">Click</a>"]');
      expect(stripMermaidDangerousHtml(nestedOnload)).toBe('D["<img src=x >"]');
    });
  });
});
