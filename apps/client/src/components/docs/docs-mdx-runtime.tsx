import React from 'react';
import defaultComponents from 'fumadocs-ui/mdx';
import YouTube from '@/components/mdx/YouTube';
import DynamicVar from '@/components/mdx/DynamicVar';
import MicroQuiz from '@/components/mdx/MicroQuiz';
import WhiteboardImage from '@/components/mdx/WhiteboardImage';
import Callout from '@/components/mdx/Callout';
import Summary from '@/components/mdx/Summary';
import CodeGroup, { CodeGroupItem } from '@/components/mdx/CodeGroup';
import { Steps, Step } from '@/components/mdx/Steps';
import { CardGroup, Card } from '@/components/mdx/Cards';
import { AccordionGroup, Accordion } from '@/components/mdx/Accordion';
import Expandable from '@/components/mdx/Expandable';
import SmartTable from '@/components/mdx/SmartTable';
import { Mermaid } from '@/components/mdx/DynamicClientComponents';
import { InterleafAnswer } from '@/components/mdx/InterleafAnswer';
import { SandboxPre } from '@/components/mdx/SandboxPre';
import { CodeAnchor } from '@/components/mdx/CodeAnchor';
import { ENGINE_CONFIG } from '@/lib/config';
import { prepareMdxSource, scanFallbackTocAndDeepDives } from '@/lib/mdx/prepareMdxSource';
import { cachedCompileMdx, mdxCompiler, readDeepDiveCount, sanitizeTocItems } from '@/lib/mdx/compile-cache';
import { normalizeTitleForMatch } from '@/lib/mdx/remark-doc-hygiene';
import { healMdxSource } from '@/lib/mdx/ast-healer';
import { resolveWebDocHref, type WebDocLinkContext } from '@/lib/docs/webdoc-href-resolver';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';

function UnknownMdxComponent(props: any) {
  return <>{props?.children ?? null}</>;
}

export function flattenAnchors(children: React.ReactNode): React.ReactNode {
  if (children === null || children === undefined || typeof children === 'string' || typeof children === 'number' || typeof children === 'boolean') {
    return children;
  }
  if (Array.isArray(children)) {
    return children.map((c, i) => <React.Fragment key={i}>{flattenAnchors(c)}</React.Fragment>);
  }
  if (React.isValidElement(children)) {
    const el = children as React.ReactElement<any>;
    const innerChildren = el.props?.children !== undefined ? flattenAnchors(el.props.children) : undefined;
    if (el.type === 'a' || el.props?.href !== undefined) {
      return <span key={el.key ?? undefined}>{innerChildren}</span>;
    }
    if (innerChildren !== undefined) {
      return React.cloneElement(el, { key: el.key ?? undefined }, innerChildren);
    }
    return el;
  }
  return null;
}

export function SafeHeading({ as, children, className, ...props }: any) {
  const Comp = (defaultComponents as any)?.[as] || as;
  return (
    <Comp
      {...props}
      className={cn(
        'no-underline text-theme-foreground [&>a]:no-underline [&>a]:text-inherit [&>a]:cursor-inherit [&>a:hover]:no-underline [&>a:hover]:text-inherit',
        className
      )}
    >
      {flattenAnchors(children)}
    </Comp>
  );
}

import { ComponentErrorBoundary } from '@/components/ui/ComponentErrorBoundary';

export interface BuildCustomComponentsOptions {
  owner: string;
  repo: string;
  gitSha?: string | null;
  branch?: string | null;
  webDocLinkContext?: WebDocLinkContext | null;
}

export function buildDocCustomComponents({ owner, repo, gitSha, branch, webDocLinkContext }: BuildCustomComponentsOptions): Record<string, any> {
  const resolveCardProps = (props: any) => {
    if (!webDocLinkContext || typeof props?.href !== 'string') {
      return props;
    }
    return {
      ...props,
      href: resolveWebDocHref(props.href, webDocLinkContext),
    };
  };

  return {
    ...defaultComponents,
    YouTube,
    DynamicVar,
    UnknownMdxComponent,
    Jargon: ({ children }: any) => <>{children}</>,
    WhiteboardImage,
    MicroQuiz: (props: any) => (
      <ComponentErrorBoundary fallbackTitle={m.quiz_fallback_error_title()}>
        <MicroQuiz {...props} />
      </ComponentErrorBoundary>
    ),
    Callout,
    callout: Callout,
    Summary,
    CodeGroup,
    CodeGroupItem,
    CodeBlock: CodeGroup,
    codeblock: CodeGroup,
    'code-block': CodeGroup,
    codeblockitem: CodeGroupItem,
    Steps,
    steps: Steps,
    Step,
    step: Step,
    CardGroup,
    cardgroup: CardGroup,
    Card: (props: any) => <Card {...resolveCardProps(props)} />,
    card: (props: any) => <Card {...resolveCardProps(props)} />,
    AccordionGroup,
    accordiongroup: AccordionGroup,
    Accordion,
    accordion: Accordion,
    Expandable,
    expandable: Expandable,
    InterleafAnswer,
    table: SmartTable,
    SmartTable,
    smarttable: SmartTable,
    'smart-table': SmartTable,
    CodeAnchor,
    codeanchor: CodeAnchor,
    'code-anchor': CodeAnchor,
    a: (props: any) => {
      const href = props?.href;
      if (typeof href === 'string' && href.startsWith('code:')) {
        return <CodeAnchor href={href} {...props} />;
      }
      const resolvedHref =
        typeof href === 'string' && webDocLinkContext
          ? resolveWebDocHref(href, webDocLinkContext)
          : href;
      const DefaultA = (defaultComponents as any)?.a || 'a';
      return <DefaultA {...props} href={resolvedHref} />;
    },
    pre: (props: any) => {
      const child = React.Children.toArray(props.children)[0];
      if (
        child &&
        React.isValidElement<{ className?: string; 'data-language'?: string; children?: React.ReactNode }>(child) &&
        (
          child.props.className === 'language-mermaid' ||
          child.props['data-language'] === 'mermaid'
        )
      ) {
        const chartText = child.props.children;
        if (typeof chartText === 'string') {
          return (
            <ComponentErrorBoundary fallbackTitle={m.mermaid_render_failure()}>
              <Mermaid chart={chartText} />
            </ComponentErrorBoundary>
          );
        }
      }
      return <SandboxPre data-git-sha={gitSha || undefined} {...props} />;
    },
    img: (props: any) => {
      let src = props.src;
      if (
        src &&
        !src.startsWith('http') &&
        !src.startsWith('//') &&
        !src.startsWith('/api/assets/') &&
        !src.startsWith('data:image/')
      ) {
        const cleanPath = src.replace(/^\.?\//, '');
        const ref = gitSha || branch || ENGINE_CONFIG.defaultBranch;
        src = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${cleanPath}`;
      }
      const widthNum = props.width ? parseInt(String(props.width), 10) : undefined;
      if (widthNum && widthNum <= 200) {
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            {...props}
            src={src}
            alt={props.alt || ''}
            className={cn('inline-block object-contain', props.className)}
          />
        );
      }
      return <WhiteboardImage {...props} src={src} alt={props.alt} caption={props.alt} />;
    },
    h1: (props: any) => <SafeHeading as="h1" {...props} />,
    h2: (props: any) => <SafeHeading as="h2" {...props} />,
    h3: (props: any) => <SafeHeading as="h3" {...props} />,
    h4: (props: any) => <SafeHeading as="h4" {...props} />,
    h5: (props: any) => <SafeHeading as="h5" {...props} />,
    h6: (props: any) => <SafeHeading as="h6" {...props} />,
  };
}

export interface CompileDocMdxResult {
  MdxContent: any;
  safeToc: any[];
  frontmatter: any;
  compileFailed: boolean;
  deepDiveCount: number;
}

export async function compileDocMdx(
  rawMdx: string,
  relativePath: string,
  docTitle?: string | null
): Promise<CompileDocMdxResult> {
  let MdxContent: any;
  let toc: any[] = [];
  let frontmatter: any = {};
  let compileFailed = false;
  let deepDiveCount = 0;

  const source = prepareMdxSource(rawMdx);

  try {
    const compiled = await cachedCompileMdx(source);
    MdxContent = compiled.body;
    toc = compiled.toc as any[];
    frontmatter = compiled.frontmatter;
    deepDiveCount = compiled.deepDiveCount ?? 0;
  } catch (primaryErr) {
    console.warn(`[MDX Primary Compile Failed] Attempting Layer 2 AST Self-Healing pass on ${relativePath}:`, primaryErr);

    try {
      const healedSource = await healMdxSource(rawMdx);
      const compiledHealed = await mdxCompiler.compile({ source: healedSource });
      MdxContent = compiledHealed.body;
      toc = compiledHealed.toc;
      frontmatter = compiledHealed.frontmatter;
      deepDiveCount = readDeepDiveCount(compiledHealed.vfile);
      console.log(`[MDX Layer 2 Healed] Successfully re-compiled ${relativePath} after AST healing pass.`);
    } catch (secondaryErr) {
      console.error(`[MDX Layer 2 Failed] Falling back to Layer 3 GFM Rich-Text Renderer on ${relativePath}:`, secondaryErr);
      compileFailed = true;

      const fallbackScan = scanFallbackTocAndDeepDives(source);
      deepDiveCount = fallbackScan.deepDiveCount;
      if (toc.length === 0) {
        toc = fallbackScan.toc;
      }
    }
  }

  if (!compileFailed && MdxContent) {
    const fmTitle = typeof frontmatter?.title === 'string' ? frontmatter.title.trim() : '';
    const pageTitle = fmTitle || (typeof docTitle === 'string' ? docTitle.trim() : '');
    const firstToc = sanitizeTocItems(toc)[0];
    if (
      pageTitle &&
      firstToc &&
      firstToc.depth === 1 &&
      normalizeTitleForMatch(firstToc.title) === normalizeTitleForMatch(pageTitle)
    ) {
      try {
        const stripped = await cachedCompileMdx(source, 'primary:h1s');
        MdxContent = stripped.body;
        toc = stripped.toc as any[];
        frontmatter = stripped.frontmatter;
        deepDiveCount = stripped.deepDiveCount ?? deepDiveCount;
      } catch (stripErr) {
        console.warn(`[MDX H1-Strip Variant Failed] Keeping unstripped compile on ${relativePath}:`, stripErr);
      }
    }
  }

  const cleanToc = sanitizeTocItems(toc);
  const h2AndH3Items = cleanToc.filter((item) => item.depth >= 2 && item.depth <= 3);
  const maxAllowedDepth = h2AndH3Items.length > 30 ? 2 : 3;

  let safeToc = cleanToc.filter((item) => item.depth >= 2 && item.depth <= maxAllowedDepth);
  if (safeToc.length === 0 && cleanToc.length > 0) {
    safeToc = cleanToc.filter((item) => item.depth === 1);
  }

  return {
    MdxContent,
    safeToc,
    frontmatter,
    compileFailed,
    deepDiveCount,
  };
}
