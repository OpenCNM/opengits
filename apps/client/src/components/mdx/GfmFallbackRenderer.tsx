'use client';
import * as m from '@/paraglide/messages';

import React, { useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { mdxSanitizeSchema } from '@/lib/mdx/sanitize-schema';
import { rehypePolymorphicDemotion } from '@/lib/mdx/rehype-polymorphic-demotion';
import { remarkGfmAlertsPlain } from '@/lib/mdx/remark-doc-hygiene';
import { Copy, Check } from 'lucide-react';
import { prepareMdxSource } from '@/lib/mdx/prepareMdxSource';
import { resolveWebDocHref, type WebDocLinkContext } from '@/lib/docs/webdoc-href-resolver';
import WhiteboardImage from './WhiteboardImage';
import Summary from './Summary';

interface GfmFallbackRendererProps {
  content: string;
  owner?: string;
  repo?: string;
  webDocLinkContext?: WebDocLinkContext | null;
}

const getText = (node: React.ReactNode): string => {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getText).join('');
  if (React.isValidElement(node) && (node.props as any)?.children) {
    return getText((node.props as any).children);
  }
  return '';
};

function CodeBlockWithCopy({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = getText(children);
    if (text) {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Fallback
      }
    }
  };

  return (
    <div className="relative group my-6">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2.5 right-2.5 z-10 px-2 py-1 text-caption font-mono rounded bg-stone-800/90 text-stone-300 hover:text-white hover:bg-stone-700 border border-stone-700/80 transition-all opacity-80 group-hover:opacity-100 cursor-pointer flex items-center gap-1 shadow-2xs"
        title={m.common_copy()}
      >
        {copied ? (
          <>
            <Check size={12} className="text-emerald-400" />
            <span className="text-emerald-400 font-bold">{m.common_copied()}</span>
          </>
        ) : (
          <>
            <Copy size={12} />
            <span>{m.common_copy()}</span>
          </>
        )}
      </button>
      <pre className="bg-stone-900 text-stone-100 font-mono text-xs p-4 rounded-xl overflow-x-auto border border-theme-border shadow-xs [&_code]:!bg-transparent [&_code]:!border-none [&_code]:!p-0 [&_code]:!text-stone-100">
        {children}
      </pre>
    </div>
  );
}

const PreContext = React.createContext<boolean>(false);

const getSlug = (node: React.ReactNode): string => {
  const text = getText(node);
  return text.toLowerCase().replace(/[^\w\u4e00-\u9fa5\s-]+/g, '').trim().replace(/\s+/g, '-');
};

/** 降级路径 GFM alert 样式（与主链 Callout 配色对齐：emerald/violet/amber/accent） */
const GFM_ALERT_STYLES: Record<string, string> = {
  note: 'border-theme-border bg-theme-bg/70 not-italic',
  tip: 'border-emerald-700/50 bg-emerald-900/5 not-italic',
  important: 'border-violet-700/50 bg-violet-900/5 not-italic',
  warning: 'border-amber-700/50 bg-amber-900/5 not-italic',
  danger: 'border-red-800/50 bg-red-900/5 not-italic',
};

/**
 * Layer 3 Seamless GFM Rich-Text Fallback Renderer.
 * Renders raw Markdown into rich, beautifully styled Warm Editorial UI components
 * without any red warning banners or plain-text dumps.
 */
export default function GfmFallbackRenderer({ content, owner, repo, webDocLinkContext }: GfmFallbackRendererProps) {
  const cleanContent = prepareMdxSource(content);

  return (
    <div className="gfm-fallback-container font-serif text-theme-foreground max-w-none leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkGfmAlertsPlain]}
        rehypePlugins={[rehypeRaw, rehypePolymorphicDemotion, [rehypeSanitize, mdxSanitizeSchema]]}
        urlTransform={(url, key, node) => {
          const trimmed = typeof url === 'string' ? url.trim() : '';
          if (
            key === 'src' &&
            node.tagName === 'img' &&
            /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(trimmed)
          ) {
            return trimmed;
          }
          if (key === 'href' && trimmed.toLowerCase().startsWith('code:')) {
            return trimmed;
          }
          return defaultUrlTransform(url);
        }}
        components={{
          summary: ({ node, ...props }: any) => <Summary {...props} />,
          h1: ({ children }) => (
            <h1 id={getSlug(children)} className="text-3xl font-bold font-serif text-theme-foreground mt-8 mb-4">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 id={getSlug(children)} className="text-2xl font-bold font-serif text-theme-foreground mt-7 mb-3">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 id={getSlug(children)} className="text-xl font-bold font-serif text-theme-foreground mt-6 mb-2">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 id={getSlug(children)} className="text-lg font-bold font-serif text-theme-foreground mt-5 mb-2">
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="text-base text-theme-foreground leading-relaxed mb-4 font-serif">
              {children}
            </p>
          ),
          blockquote: ({ className, children }: any) => {
            const kind = /gfm-alert-(note|tip|important|warning|danger)/.exec(className || '')?.[1];
            return (
              <blockquote
                className={
                  kind
                    ? `border-l-4 pl-4 py-2 pr-3 my-6 rounded-r-lg text-sm text-theme-foreground/90 ${GFM_ALERT_STYLES[kind]}`
                    : 'border-l-4 border-theme-primary/70 pl-4 py-2 my-6 italic text-theme-muted bg-theme-primary/5 rounded-r-lg'
                }
              >
                {children}
              </blockquote>
            );
          },
          code({ className, children, node: _node, ...props }: any) {
            const isInPre = React.useContext(PreContext);
            const isBlock = isInPre || Boolean(className);
            if (isBlock) {
              return (
                <code className={`${className || ''} font-mono text-xs text-stone-100`.trim()} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="bg-theme-bg border border-theme-border font-mono text-xs px-1.5 py-0.5 rounded text-theme-primary font-semibold" {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <PreContext.Provider value={true}>
              <CodeBlockWithCopy>{children}</CodeBlockWithCopy>
            </PreContext.Provider>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-inside mb-4 space-y-1 pl-2 text-theme-foreground font-serif">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside mb-4 space-y-1 pl-2 text-theme-foreground font-serif">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="text-base leading-relaxed text-theme-foreground">
              {children}
            </li>
          ),
          img: ({ src, alt }) => {
            let resolvedSrc = typeof src === 'string' ? src : '';
            if (
              resolvedSrc &&
              owner &&
              repo &&
              !resolvedSrc.startsWith('http') &&
              !resolvedSrc.startsWith('//') &&
              !resolvedSrc.startsWith('/assets/') &&
              !resolvedSrc.startsWith('/api/assets/') &&
              !resolvedSrc.startsWith('data:image/')
            ) {
              const cleanPath = resolvedSrc.replace(/^\.\//, '');
              resolvedSrc = `https://raw.githubusercontent.com/${owner}/${repo}/main/${cleanPath}`;
            }
            return (
              <WhiteboardImage
                src={resolvedSrc}
                alt={alt || ''}
                caption={alt || ''}
                crossOrigin="anonymous"
              />
            );
          },
          table: ({ children }) => (
            <div className="overflow-x-auto my-6 rounded-xl border border-theme-border bg-theme-surface/30 shadow-2xs">
              <table className="w-full border-collapse text-sm text-theme-foreground font-serif [&_tr:last-child_td]:border-b-0">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-theme-border p-3 sm:px-4 sm:py-3 text-left font-semibold bg-theme-surface/70 font-serif text-theme-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-theme-border/60 p-3 sm:px-4 sm:py-3 font-serif">
              {children}
            </td>
          ),
          a: ({ href, children }) => {
            // code: 锚点在降级路径无 CodeDrawer/拦截器可挂：渲染为静态代码引用样式，
            // 避免把 code:xxx 当相对 URL 导航出站
            if (typeof href === 'string' && href.startsWith('code:')) {
              return (
                <span className="font-mono text-xs px-1.5 py-0.5 rounded border border-theme-border bg-theme-bg text-theme-primary font-semibold">
                  {children}
                </span>
              );
            }
            const resolvedHref =
              typeof href === 'string' && webDocLinkContext
                ? resolveWebDocHref(href, webDocLinkContext)
                : href;
            const isExternal = Boolean(resolvedHref && /^(?:https?:)?\/\//i.test(resolvedHref));
            return (
              <a
                href={resolvedHref}
                {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className="text-theme-primary hover:underline underline-offset-4 font-semibold"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {cleanContent}
      </ReactMarkdown>
    </div>
  );
}
