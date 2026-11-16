import { describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

import { mdxCompiler } from '@/lib/mdx/compile-cache';

async function compile(source: string): Promise<string> {
  const compiled = await mdxCompiler.compile({ source });
  return String(compiled.compiled ?? '');
}

describe('MDX Component Full Rendering Golden Test (B1)', () => {
  const goldenMdx = `
# SENTINEL_H1_TITLE

## SENTINEL_H2_HEADING

Here is a paragraph with **SENTINEL_BOLD_TEXT** and a standard markdown baseline.

| Col A | Col B |
| --- | --- |
| SENTINEL_TABLE_CELL_1 | SENTINEL_TABLE_CELL_2 |

<CardGroup>
  <Card title="SENTINEL_CARD_TITLE">SENTINEL_CARD_BODY</Card>
</CardGroup>

<Steps>
  <Step title="SENTINEL_STEP_TITLE">SENTINEL_STEP_BODY</Step>
</Steps>

<Callout type="info">SENTINEL_CALLOUT_BODY</Callout>

<AccordionGroup>
  <Accordion title="SENTINEL_ACCORDION_TITLE">SENTINEL_ACCORDION_BODY</Accordion>
</AccordionGroup>

<Expandable title="SENTINEL_EXPANDABLE_TITLE">SENTINEL_EXPANDABLE_BODY</Expandable>

<CodeGroup>
  <CodeGroupItem title="SENTINEL_CODE_TAB">console.log("SENTINEL_CODE_CONTENT");</CodeGroupItem>
</CodeGroup>

Dynamic brace test: {SENTINEL_DYNAMIC_VAR}

<Summary>SENTINEL_SUMMARY_BODY</Summary>

<Jargon term="SENTINEL_JARGON_TERM">SENTINEL_JARGON_BODY</Jargon>

<InterleafAnswer>SENTINEL_INTERLEAF_BODY</InterleafAnswer>

<YouTube id="SENTINEL_YT_VIDEO_123" />

<WhiteboardImage src="SENTINEL_WHITEBOARD_IMG.png" alt="SENTINEL_WHITEBOARD_ALT" />

<MicroQuiz question="SENTINEL_QUIZ_QUESTION">SENTINEL_QUIZ_BODY</MicroQuiz>

\`\`\`mermaid
graph TD
  A[SENTINEL_MERMAID_NODE_A] --> B[SENTINEL_MERMAID_NODE_B]
\`\`\`

<BogusCustomWidget>SENTINEL_UNKNOWN_WIDGET_BODY</BogusCustomWidget>
`;

  it('compiles golden document containing all custom MDX components and markdown baseline', async () => {
    const compiled = await compile(goldenMdx);

    // 1. All component identifiers are preserved in compiled output
    const expectedComponents = [
      'CardGroup',
      'Card',
      'Steps',
      'Step',
      'Callout',
      'AccordionGroup',
      'Accordion',
      'Expandable',
      'CodeGroup',
      'CodeGroupItem',
      'DynamicVar',
      'Summary',
      'Jargon',
      'InterleafAnswer',
      'YouTube',
      'WhiteboardImage',
      'MicroQuiz',
      'UnknownMdxComponent',
    ];

    for (const comp of expectedComponents) {
      expect(compiled, `Component "${comp}" must be preserved in compiled output`).toContain(comp);
    }

    // 2. All sentinel strings are preserved in compiled output
    const expectedSentinels = [
      'SENTINEL_H1_TITLE',
      'SENTINEL_H2_HEADING',
      'SENTINEL_BOLD_TEXT',
      'SENTINEL_TABLE_CELL_1',
      'SENTINEL_TABLE_CELL_2',
      'SENTINEL_CARD_TITLE',
      'SENTINEL_CARD_BODY',
      'SENTINEL_STEP_TITLE',
      'SENTINEL_STEP_BODY',
      'SENTINEL_CALLOUT_BODY',
      'SENTINEL_ACCORDION_TITLE',
      'SENTINEL_ACCORDION_BODY',
      'SENTINEL_EXPANDABLE_TITLE',
      'SENTINEL_EXPANDABLE_BODY',
      'SENTINEL_CODE_TAB',
      'SENTINEL_CODE_CONTENT',
      'SENTINEL_DYNAMIC_VAR',
      'SENTINEL_SUMMARY_BODY',
      'SENTINEL_JARGON_TERM',
      'SENTINEL_JARGON_BODY',
      'SENTINEL_INTERLEAF_BODY',
      'SENTINEL_YT_VIDEO_123',
      'SENTINEL_WHITEBOARD_IMG.png',
      'SENTINEL_WHITEBOARD_ALT',
      'SENTINEL_QUIZ_QUESTION',
      'SENTINEL_QUIZ_BODY',
      'SENTINEL_MERMAID_NODE_A',
      'SENTINEL_MERMAID_NODE_B',
      'SENTINEL_UNKNOWN_WIDGET_BODY',
    ];

    for (const sentinel of expectedSentinels) {
      expect(compiled, `Sentinel "${sentinel}" must be present in compiled output`).toContain(sentinel);
    }

    // 3. No internal placeholder delimiters (\uE000 / \uE001) remain
    expect(compiled).not.toContain('\uE000');
    expect(compiled).not.toContain('\uE001');

    // 4. Unknown custom widget is rewritten to UnknownMdxComponent without leaking BogusCustomWidget
    expect(compiled).not.toContain('BogusCustomWidget');
    expect(compiled).toContain('UnknownMdxComponent');
  });
});
