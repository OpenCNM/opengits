import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => React.createElement('a', { href, ...rest }, children),
}));

import { CardGroup, Card } from '@/components/mdx/Cards';
import CodeGroup, { CodeGroupItem } from '@/components/mdx/CodeGroup';
import { buildDocCustomComponents, compileDocMdx } from '@/components/docs/docs-mdx-runtime';
import GfmFallbackRenderer from '@/components/mdx/GfmFallbackRenderer';
import { buildWebDocLinkContext } from '@/lib/docs/webdoc-href-resolver';
import type { OutlineView } from '@/lib/outline-reader';
import { mdxCompiler } from '@/lib/mdx/compile-cache';

describe('MDX Cards & CodeGroup visual parity hardening', () => {
  it('normalizes string cols on CardGroup cleanly across 1..4 and unknown fallbacks', () => {
    const html3 = renderToStaticMarkup(
      React.createElement(CardGroup, { cols: '3' }, React.createElement(Card, { title: 'A' }, 'Body'))
    );
    expect(html3).toContain('md:grid-cols-3');

    const html4 = renderToStaticMarkup(
      React.createElement(CardGroup, { cols: ' 4 ' }, React.createElement(Card, { title: 'B' }, 'Body'))
    );
    expect(html4).toContain('lg:grid-cols-4');

    const htmlInvalid = renderToStaticMarkup(
      React.createElement(CardGroup, { cols: '99' }, React.createElement(Card, { title: 'C' }, 'Body'))
    );
    expect(htmlInvalid).toContain('md:grid-cols-2');
  });

  it('renders Card eyebrow, wraps long titles without truncate, avoids nested <p>, and marks external links', () => {
    const htmlExternal = renderToStaticMarkup(
      React.createElement(
        Card,
        {
          title: 'Multi-Word Long Integration Capability Title Without Clipping',
          eyebrow: 'For your team',
          href: 'https://eve.dev/docs/integrations',
          description: 'Short summary',
        },
        React.createElement('p', null, 'Connect Slack, Microsoft Teams, and GitHub seamlessly.')
      )
    );

    expect(htmlExternal).toContain('For your team');
    expect(htmlExternal).toContain('target="_blank"');
    expect(htmlExternal).toContain('rel="noopener noreferrer"');
    expect(htmlExternal).toContain('leading-snug break-words');
    expect(htmlExternal).not.toContain('truncate');
    // Ensure description <p> and children <div> are siblings (zero nested <p> hydration traps)
    expect(htmlExternal).toMatch(/<p[^>]*>Short summary<\/p><div[^>]*><p>Connect Slack/);

    const htmlInternal = renderToStaticMarkup(
      React.createElement(
        Card,
        {
          title: 'Internal Guide',
          href: '/docs/acme/repo/docs/guide',
        },
        'Internal child text'
      )
    );
    expect(htmlInternal).toContain('href="/docs/acme/repo/docs/guide"');
    expect(htmlInternal).not.toContain('target="_blank"');
  });

  it('extracts language and data-code inside CodeGroup when compiled pre carries data-* attributes', () => {
    const fakeCompiledPre = React.createElement(
      'pre',
      {
        'data-language': 'typescript',
        'data-code': 'export const runAgent = async () => {\n  return true;\n};',
      },
      React.createElement('code', null, 'export const runAgent = async () => {};')
    );

    const html = renderToStaticMarkup(
      React.createElement(
        CodeGroup,
        null,
        React.createElement(CodeGroupItem, { title: 'SDK Setup' }, fakeCompiledPre)
      )
    );

    expect(html).toContain('SDK Setup');
    expect(html).toContain('typescript');
    expect(html).not.toContain('>text<');
  });

  it('compiles full Go-lifted WebDoc MDX payload via mdxCompiler without syntax or JSX errors', async () => {
    const goLiftedMdx = `
# Use Cases

<CardGroup cols="2">
<Card title="Customer Support Triage" eyebrow="For your team" href="/docs/use-cases/support">

Automate triage across \`Slack\` · \`Microsoft Teams\` · \`GitHub\`.

</Card>
<Card title="Incident Copilot" eyebrow="For reliability" href="/docs/use-cases/incident">

Correlate error spikes across services.

</Card>
</CardGroup>

![Architecture](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMTIwIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjQwIi8+PC9zdmc+)

<Callout type="warning" title="Rate Limit Notice">

Backoff retries trigger automatically up to five attempts.

</Callout>

<CodeGroup>
<CodeGroupItem title="TypeScript">

\`\`\`ts
export const ready = true;
\`\`\`

</CodeGroupItem>
<CodeGroupItem title="Python">

\`\`\`python
ready = True
\`\`\`

</CodeGroupItem>
</CodeGroup>

<AccordionGroup>
<Accordion title="How do I rotate keys?">

Use dual-secret mode during rotation windows.

</Accordion>
<Accordion title="How do I revoke tokens?">

Revoke tokens immediately from workspace settings.

</Accordion>
</AccordionGroup>

<Steps>
<Step title="Install">

Run pnpm install.

</Step>
<Step title="Verify">

Run health checks.

</Step>
</Steps>
`;

    const result = await mdxCompiler.compile({ source: goLiftedMdx });
    const compiled = String(result.compiled ?? '');
    expect(compiled).toContain('CardGroup');
    expect(compiled).toContain('Card');
    expect(compiled).toContain('Callout');
    expect(compiled).toContain('CodeGroup');
    expect(compiled).toContain('CodeGroupItem');
    expect(compiled).toContain('AccordionGroup');
    expect(compiled).toContain('Accordion');
    expect(compiled).toContain('Steps');
    expect(compiled).toContain('Step');
    expect(compiled).toContain('data:image/svg+xml;base64,');

    const components = buildDocCustomComponents({
      owner: 'acme',
      repo: 'eve-docs',
    });
    const renderedElement = await result.body({ components });
    const ssrHtml = renderToStaticMarkup(renderedElement);

    expect(ssrHtml).toContain('Customer Support Triage');
    expect(ssrHtml).toContain('For your team');
    expect(ssrHtml).toContain('Rate Limit Notice');
    expect(ssrHtml).toContain('Backoff retries trigger automatically up to five attempts.');
    expect(ssrHtml).toContain('TypeScript');
    expect(ssrHtml).toContain('Python');
    expect(ssrHtml).toContain('How do I rotate keys?');
    expect(ssrHtml).toContain('How do I revoke tokens?');
    expect(ssrHtml).toContain('Install');
    expect(ssrHtml).toContain('Run pnpm install.');
    expect(ssrHtml).toContain('Verify');
    expect(ssrHtml).toContain('src="data:image/svg+xml;base64,');
    expect(ssrHtml).toContain('alt="Architecture"');
    expect(ssrHtml).not.toContain('raw.githubusercontent.com');
  });

  it('compileDocMdx Layer 1 compiles and SSR-renders Phase 1/2 components and inline data:image/svg+xml cleanly', async () => {
    const inlineSvgDataUri =
      'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTYwIj48cmVjdCB4PSIxMCIgeT0iMTAiIHdpZHRoPSIxMDAiIGhlaWdodD0iNDAiLz48L3N2Zz4=';
    const rawMdx = [
      '# Use Cases',
      '',
      '<CardGroup cols="3">',
      '<Card title="Marketing team" href="https://github.com/vercel-labs/eve-marketing-template">',
      '',
      'Plan launches across channels.',
      '',
      'Marketing team template',
      '',
      '</Card>',
      '<Card title="Support triage" href="/docs/use-cases/support">',
      '',
      'Automate escalation routing.',
      '',
      '</Card>',
      '<Card title="Revenue ops" href="#business-agents">',
      '',
      'Sync CRM updates in real time.',
      '',
      '</Card>',
      '</CardGroup>',
      '',
      `![Architecture](${inlineSvgDataUri})`,
      '',
      '<Callout type="info" title="Prerequisites">',
      '',
      'Configure API keys before running workflows.',
      '',
      '</Callout>',
      '',
      '<CodeGroup>',
      '<CodeGroupItem title="Shell">',
      '',
      '```bash',
      'npx eve init',
      '```',
      '',
      '</CodeGroupItem>',
      '</CodeGroup>',
      '',
      '<AccordionGroup>',
      '<Accordion title="Which channels are supported?">',
      '',
      'Slack, iMessage, and Microsoft Teams.',
      '',
      '</Accordion>',
      '<Accordion title="Can agents run on a schedule?">',
      '',
      'Yes, configure cron triggers per workflow.',
      '',
      '</Accordion>',
      '</AccordionGroup>',
      '',
      '<Steps>',
      '<Step title="Connect Channel">',
      '',
      'Authorize Slack workspace.',
      '',
      '</Step>',
      '<Step title="Deploy Agent">',
      '',
      'Start durable worker.',
      '',
      '</Step>',
      '</Steps>',
    ].join('\n');

    const { MdxContent, compileFailed } = await compileDocMdx(rawMdx, 'docs/use-cases.md', 'Use Cases');
    expect(compileFailed).toBe(false);
    expect(MdxContent).toBeTruthy();

    const linkCtx = buildWebDocLinkContext({
      owner: 'acme',
      repo: 'eve-docs',
      repoProfile: { originalUrl: 'https://eve.dev/docs/use-cases' },
      outline: {
        outlineId: 'o1',
        version: 1,
        mode: 'doc',
        parts: [],
        chapters: [
          {
            id: 'c1',
            title: 'Support',
            summary: null,
            chapterType: 'doc',
            teachingOrder: 1,
            nodes: [
              {
                id: 'n1',
                title: 'Support',
                nodeType: 'doc',
                headingPath: null,
                documentId: 'd1',
                docPath: 'docs/use-cases/support.md',
                docStatus: 'PROCESSED',
              },
            ],
          },
        ],
      },
      currentDocPath: 'docs/use-cases.md',
    });

    const components = buildDocCustomComponents({
      owner: 'acme',
      repo: 'eve-docs',
      webDocLinkContext: linkCtx,
    });
    const html = renderToStaticMarkup(React.createElement(MdxContent, { components }));

    expect(html).toContain('md:grid-cols-3');
    expect(html).toContain('href="https://github.com/vercel-labs/eve-marketing-template"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('href="/docs/acme/eve-docs/docs/use-cases/support"');
    expect(html).toContain('href="#business-agents"');
    expect(html).toContain(`src="${inlineSvgDataUri}"`);
    expect(html).toContain('alt="Architecture"');
    expect(html).toContain('Prerequisites');
    const plainText = html.replace(/<[^>]+>/g, '');
    expect(plainText).toContain('npx eve init');
    expect(html).toContain('Which channels are supported?');
    expect(html).toContain('Can agents run on a schedule?');
    expect(html).toContain('Connect Channel');
    expect(html).toContain('Deploy Agent');
  });

  it('compiles Go-lifted Eve Use Cases payload (:h1s + 2-col/3-col CardGroup + 9-item list + nested SVG data URI)', async () => {
    const inlineSvgDataUri =
      'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMTAwIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjUwIi8+PC9zdmc+';
    const eveLiftedMdx = [
      '# Use Cases',
      '',
      "eve's two most common use cases are business agents and AaaS.",
      '',
      '<CardGroup cols="2">',
      '<Card title="Business agents" eyebrow="For your team" href="#business-agents">',
      '',
      'Automate a company function.',
      '',
      '`Slack` · `Microsoft Teams` · `GitHub` · `Linear` · `Web`',
      '',
      '</Card>',
      '<Card title="Agent as a Service (AaaS)" eyebrow="For your customers" href="#agent-as-a-service-aaas">',
      '',
      'Build multi-tenant agentic applications.',
      '',
      '`iMessage` · `WhatsApp` · `Telegram` · `Discord` · `Web`',
      '',
      '</Card>',
      '</CardGroup>',
      '',
      '## Business agents',
      '',
      '<CardGroup cols="3">',
      '<Card title="Software factory" href="https://github.com/vercel-labs/eve-software-factory-template/tree/main">',
      '',
      'Agents plan features alongside an engineering team.',
      '',
      'Software Factory template',
      '',
      '</Card>',
      '<Card title="Company brain" href="https://github.com/vercel/eve/tree/main/apps/templates/eve-company-brain-template">',
      '',
      'One agent holds the company skills.',
      '',
      'Company Brain template',
      '',
      '</Card>',
      '<Card title="Marketing team" href="https://github.com/vercel-labs/marketing-team-eve-template/tree/main">',
      '',
      'A lead agent routes work to specialists.',
      '',
      'Marketing team template',
      '',
      '</Card>',
      '</CardGroup>',
      '',
      '### How eve supports business agents',
      '',
      '- Meet employees where they work',
      '',
      '  One agent serves Slack and Teams.',
      '',
      '  [Channels](/docs/channels)',
      '- Govern and audit every run',
      '',
      '  OpenTelemetry traces record every session.',
      '',
      '  [Observability](/docs/observability/instrumentation)',
      '',
      '<Callout type="tip" title="Diagram">',
      '',
      `![Nested Topology](${inlineSvgDataUri})`,
      '',
      '</Callout>',
    ].join('\n');

    const { MdxContent, compileFailed, safeToc } = await compileDocMdx(eveLiftedMdx, 'docs/use-cases.md', 'Use Cases');
    expect(compileFailed).toBe(false);
    expect(safeToc.some((item: any) => item.title === 'Business agents')).toBe(true);

    const linkCtx = buildWebDocLinkContext({
      owner: 'acme',
      repo: 'eve-docs',
      repoProfile: { originalUrl: 'https://eve.dev/docs/use-cases' },
      outline: {
        outlineId: 'o1',
        version: 1,
        mode: 'doc',
        parts: [],
        chapters: [
          {
            id: 'c1',
            title: 'Channels',
            summary: null,
            chapterType: 'doc',
            teachingOrder: 1,
            nodes: [
              {
                id: 'n1',
                title: 'Channels',
                nodeType: 'doc',
                headingPath: null,
                documentId: 'd1',
                docPath: 'docs/channels.md',
                docStatus: 'PROCESSED',
              },
            ],
          },
        ],
      },
      currentDocPath: 'docs/use-cases.md',
    });

    const components = buildDocCustomComponents({
      owner: 'acme',
      repo: 'eve-docs',
      webDocLinkContext: linkCtx,
    });
    const html = renderToStaticMarkup(React.createElement(MdxContent, { components }));

    expect(html).not.toContain('<h1>Use Cases</h1>');
    expect(html).toContain('md:grid-cols-2');
    expect(html).toContain('md:grid-cols-3');
    expect(html).toContain('Agent as a Service (AaaS)');
    expect(html).toContain('Software Factory template');
    expect(html).toContain('href="/docs/acme/eve-docs/docs/channels"');
    expect(html).toContain('href="https://eve.dev/docs/observability/instrumentation"');
    expect(html).toContain(`src="${inlineSvgDataUri}"`);
    expect(html).toContain('alt="Nested Topology"');
  });

  it('renders mailto/tel Card links without _blank or internal routing bugs', () => {
    const mailHtml = renderToStaticMarkup(
      React.createElement(Card, { title: 'Support', href: 'mailto:support@example.com' }, 'Email team')
    );
    expect(mailHtml).toContain('href="mailto:support@example.com"');
    expect(mailHtml).not.toContain('target="_blank"');

    const telHtml = renderToStaticMarkup(
      React.createElement(Card, { title: 'Hotline', href: 'tel:+18005551234' }, 'Call us')
    );
    expect(telHtml).toContain('href="tel:+18005551234"');
    expect(telHtml).not.toContain('target="_blank"');
  });

  it('resolves Card and anchor hrefs via buildDocCustomComponents webDocLinkContext', () => {
    const sampleOutline: OutlineView = {
      outlineId: 'o1',
      version: 1,
      mode: 'doc',
      parts: [],
      chapters: [
        {
          id: 'c1',
          title: 'Use Cases',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n1',
              title: 'Inbox',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd1',
              docPath: 'docs/use-cases/inbox.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };
    const linkCtx = buildWebDocLinkContext({
      owner: 'acme',
      repo: 'eve-docs',
      repoProfile: { originalUrl: 'https://eve.dev/docs/use-cases' },
      outline: sampleOutline,
      currentDocPath: 'docs/use-cases.md',
    });

    const components = buildDocCustomComponents({
      owner: 'acme',
      repo: 'eve-docs',
      webDocLinkContext: linkCtx,
    });
    const InOutlineCard = components.Card;
    const internalHtml = renderToStaticMarkup(
      React.createElement(InOutlineCard, { title: 'Inbox', href: '/docs/use-cases/inbox' }, 'Indexed page')
    );
    expect(internalHtml).toContain('href="/docs/acme/eve-docs/docs/use-cases/inbox"');
    expect(internalHtml).not.toContain('target="_blank"');

    const unindexedHtml = renderToStaticMarkup(
      React.createElement(InOutlineCard, { title: 'Pricing', href: '/pricing' }, 'Upstream fallback')
    );
    expect(unindexedHtml).toContain('href="https://eve.dev/pricing"');
    expect(unindexedHtml).toContain('target="_blank"');
  });

  it('GfmFallbackRenderer preserves data:image/svg+xml diagrams and rewrites internal hrefs', () => {
    const sampleOutline: OutlineView = {
      outlineId: 'o1',
      version: 1,
      mode: 'doc',
      parts: [],
      chapters: [
        {
          id: 'c1',
          title: 'Docs',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n1',
              title: 'API',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd1',
              docPath: 'docs/api.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };
    const linkCtx = buildWebDocLinkContext({
      owner: 'acme',
      repo: 'eve-docs',
      repoProfile: { originalUrl: 'https://eve.dev/docs/use-cases' },
      outline: sampleOutline,
    });

    const html = renderToStaticMarkup(
      React.createElement(GfmFallbackRenderer, {
        content: [
          '# Diagram Fallback',
          '',
          'See [API Docs](/docs/api) and [Changelog](/changelog).',
          '',
          '![Architecture](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==)',
        ].join('\n'),
        owner: 'acme',
        repo: 'eve-docs',
        webDocLinkContext: linkCtx,
      })
    );

    expect(html).toContain('href="/docs/acme/eve-docs/docs/api"');
    expect(html).toContain('href="https://eve.dev/changelog"');
    expect(html).toContain('src="data:image/svg+xml;base64,');
  });

  it('compiles CardGroup starting at byte zero with healed curly braces and escaped attrs', async () => {
    const healedCardSource = `<CardGroup cols="2">
<Card title="Events &amp; &quot;Webhooks&quot;" href="/docs/webhooks">

Send payload &#123; "event": "ok" &#125; to endpoint.

</Card>
<Card title="Triage" href="/docs/triage">

Classify requests &#123; a: 1 &#125; automatically.

</Card>
</CardGroup>`;

    const result = await mdxCompiler.compile({ source: healedCardSource });
    const compiled = String(result.compiled ?? '');
    expect(compiled).toContain('CardGroup');
    expect(compiled).toContain('Card');
  });
});
