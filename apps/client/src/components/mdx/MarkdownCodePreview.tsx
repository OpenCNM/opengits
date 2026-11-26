'use client';

import React, { useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkGfmAlertsPlain } from '@/lib/mdx/remark-doc-hygiene';
import { splitMarkdownPreviewOmission } from './markdown-code-preview-utils';

const PREVIEW_REMARK_PLUGINS = [remarkGfm, remarkGfmAlertsPlain];
const PreviewPreContext = React.createContext<boolean>(false);

const ALERT_STYLES: Record<string, string> = {
  note: 'border-theme-border bg-theme-bg/70 not-italic',
  tip: 'border-emerald-700/50 bg-emerald-900/5 not-italic',
  important: 'border-violet-700/50 bg-violet-900/5 not-italic',
  warning: 'border-amber-700/50 bg-amber-900/5 not-italic',
  danger: 'border-red-800/50 bg-red-900/5 not-italic',
};

function PreviewCodeBlock({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  const isInPre = React.useContext(PreviewPreContext);
  const isBlock = isInPre || Boolean(className);
  if (isBlock) {
    return (
      <code className={`${className || ''} font-mono text-xs text-theme-foreground`.trim()} {...props}>
        {children}
      </code>
    );
  }
  return (
    <code
      className="bg-theme-bg border border-theme-border/80 font-mono text-xs px-1.5 py-0.5 rounded text-theme-primary"
      {...props}
    >
      {children}
    </code>
  );
}

export interface MarkdownCodePreviewProps {
  content: string;
}

export function MarkdownCodePreview({ content }: MarkdownCodePreviewProps) {
  const { markdown, omissionNotice } = useMemo(
    () => splitMarkdownPreviewOmission(content),
    [content]
  );

  return (
    <div className="font-sans text-sm text-theme-foreground leading-relaxed space-y-3">
      <ReactMarkdown
        remarkPlugins={PREVIEW_REMARK_PLUGINS}
        urlTransform={defaultUrlTransform}
        components={{
          h1: ({ children }) => (
            <h1 className="text-lg font-bold text-theme-foreground border-b border-theme-border/60 pb-1.5 mt-3 first:mt-0 mb-2">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-base font-bold text-theme-foreground mt-4 first:mt-0 mb-1.5">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold text-theme-foreground mt-3 first:mt-0 mb-1">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-sm font-medium text-theme-foreground mt-2.5 first:mt-0 mb-1">
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="text-sm text-theme-foreground/95 leading-relaxed my-2 first:mt-0 last:mb-0">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-outside pl-5 my-2 space-y-1 text-sm text-theme-foreground/95">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-outside pl-5 my-2 space-y-1 text-sm text-theme-foreground/95">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed">{children}</li>
          ),
          blockquote: ({ className, children }) => {
            const kind = /gfm-alert-(note|tip|important|warning|danger)/.exec(className || '')?.[1];
            return (
              <blockquote
                className={
                  kind
                    ? `border-l-2 pl-3 py-1.5 pr-2 my-2.5 rounded-r-md text-xs text-theme-foreground/90 ${ALERT_STYLES[kind]}`
                    : 'border-l-2 border-theme-primary/60 pl-3 py-1 my-2.5 text-theme-muted bg-theme-bg/60 rounded-r-md'
                }
              >
                {children}
              </blockquote>
            );
          },
          pre: ({ children }) => (
            <PreviewPreContext.Provider value={true}>
              <pre className="bg-theme-bg border border-theme-border/80 text-theme-foreground font-mono text-xs p-3 rounded-lg overflow-x-auto my-2.5 [&_code]:!bg-transparent [&_code]:!border-none [&_code]:!p-0">
                {children}
              </pre>
            </PreviewPreContext.Provider>
          ),
          code: PreviewCodeBlock,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2.5 rounded-lg border border-theme-border bg-theme-bg/50">
              <table className="w-full border-collapse text-xs text-theme-foreground [&_tr:last-child_td]:border-b-0">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-theme-border px-3 py-2 text-left font-semibold bg-theme-surface/80 text-theme-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-theme-border/60 px-3 py-2 text-theme-foreground/90">
              {children}
            </td>
          ),
          hr: () => <hr className="my-3 border-theme-border/60" />,
          a: ({ href, children }) => {
            const isExternal = Boolean(href && /^(?:https?:)?\/\//i.test(href));
            return (
              <a
                href={href}
                {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className="text-theme-primary hover:underline underline-offset-4 font-medium"
              >
                {children}
              </a>
            );
          },
          img: ({ src, alt }) =>
            src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={alt || ''}
                loading="lazy"
                className="max-w-full rounded-lg border border-theme-border/80 my-2"
              />
            ) : null,
        }}
      >
        {markdown}
      </ReactMarkdown>

      {omissionNotice && (
        <div className="mt-3 pt-2 border-t border-theme-border/50 text-caption font-mono text-theme-muted">
          {omissionNotice}
        </div>
      )}
    </div>
  );
}
