import { createHighlighter, type Highlighter, type BundledLanguage, type BundledTheme } from 'shiki';
import { ignoreBestEffort } from '@/lib/best-effort';
import {
  resolveHighlightLanguage,
  SYNTAX_PRELOAD_LANGUAGES,
} from '@/engine/languages';

export interface HighlightWasmOptions {
  lang?: string;
  theme?: string;
  themes?: {
    light?: string;
    dark?: string;
    parchment?: string;
    vercel?: string;
    [key: string]: string | undefined;
  };
  defaultColor?: false | string;
}

const PRELOAD_THEMES: BundledTheme[] = [
  'github-light',
  'github-dark',
  'solarized-light',
];

const DEFAULT_MULTI_THEMES = {
  light: 'github-light',
  dark: 'github-dark',
  parchment: 'solarized-light',
  vercel: 'github-light',
};

let highlighterPromise: Promise<Highlighter> | null = null;

interface CacheEntry {
  html: string;
}

const highlightCache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 1000;
let cacheHits = 0;
let cacheMisses = 0;

export function getHighlightCacheStats(): { size: number; hits: number; misses: number } {
  return {
    size: highlightCache.size,
    hits: cacheHits,
    misses: cacheMisses,
  };
}

export function clearHighlightCache(): void {
  highlightCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

export async function getWasmHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: PRELOAD_THEMES,
      langs: [...SYNTAX_PRELOAD_LANGUAGES] as BundledLanguage[],
    });
  }
  return highlighterPromise;
}

export { resolveHighlightLanguage };

export async function highlightCodeWasm(
  code: string,
  options?: HighlightWasmOptions,
): Promise<string> {
  if (!code) return '';

  // Strip trailing newline emitted by AST parsers so Shiki does not render an extra blank line.
  const cleanCode = code.replace(/\r?\n$/, '');
  if (!cleanCode) return '';

  const lang = resolveHighlightLanguage(options?.lang);
  const themes = options?.themes || DEFAULT_MULTI_THEMES;
  const cacheKey = `${lang}:${JSON.stringify(themes)}:${cleanCode}`;

  const cached = highlightCache.get(cacheKey);
  if (cached) {
    cacheHits++;
    highlightCache.delete(cacheKey);
    highlightCache.set(cacheKey, cached);
    return cached.html;
  }

  cacheMisses++;

  const highlighter = await getWasmHighlighter();

  let targetLang = lang;
  const loadedLangs = highlighter.getLoadedLanguages();
  if (targetLang !== 'text' && !loadedLangs.includes(targetLang)) {
    try {
      await highlighter.loadLanguage(targetLang as BundledLanguage);
    } catch {
      ignoreBestEffort();
      targetLang = 'text';
    }
  }

  const html = highlighter.codeToHtml(cleanCode, {
    lang: targetLang,
    themes,
    defaultColor: options?.defaultColor ?? false,
    transformers: [
      {
        line(node, line) {
          node.properties = node.properties || {};
          node.properties['data-line'] = line;
          node.properties['id'] = `L${line}`;
        },
      },
    ],
  });

  if (highlightCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = highlightCache.keys().next().value;
    if (oldestKey !== undefined) {
      highlightCache.delete(oldestKey);
    }
  }

  highlightCache.set(cacheKey, { html });
  return html;
}
