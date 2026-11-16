/**
 * apps/client/src/lib/wasm/syntax-highlighter-wasm.ts
 *
 * WASM Syntax Highlighting & Tokenization Decoupler (TOP 2 Performance Substrate).
 *
 * Decouples code block highlighting from MDX AST compilation:
 * - Powered by Oniguruma WASM engine for native microsecond tokenization
 * - Supports Multi-Theme CSS variables (vercel, parchment, dark)
 * - Zero React Fiber / Hast <span> node bloat in V8 heap
 * - Built-in LRU memory cache for 0ms repeated code block rendering
 */

import { createHighlighter, type Highlighter, type BundledLanguage, type BundledTheme } from 'shiki';
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

// Singleton highlighter instance promise
let highlighterPromise: Promise<Highlighter> | null = null;

// High performance O(1) LRU Memory Cache
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

/**
 * Initializes or returns the singleton Shiki Oniguruma WASM highlighter.
 */
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

/**
 * Fast WASM Code Highlighter with LRU caching and Multi-Theme CSS output.
 */
export async function highlightCodeWasm(
  code: string,
  options?: HighlightWasmOptions,
): Promise<string> {
  if (!code) return '';

  // 统一防御：剥离 AST 解析器追加的代码块末尾多余换行符，杜绝末尾生成空白代码行
  const cleanCode = code.replace(/\r?\n$/, '');
  if (!cleanCode) return '';

  const lang = resolveHighlightLanguage(options?.lang);
  const themes = options?.themes || DEFAULT_MULTI_THEMES;
  const cacheKey = `${lang}:${JSON.stringify(themes)}:${cleanCode}`;

  // Check LRU Cache
  const cached = highlightCache.get(cacheKey);
  if (cached) {
    cacheHits++;
    // Re-insert to refresh LRU recency
    highlightCache.delete(cacheKey);
    highlightCache.set(cacheKey, cached);
    return cached.html;
  }

  cacheMisses++;

  const highlighter = await getWasmHighlighter();

  // Ensure language is loaded if not part of preloaded bundle
  let targetLang = lang;
  const loadedLangs = highlighter.getLoadedLanguages();
  if (targetLang !== 'text' && !loadedLangs.includes(targetLang)) {
    try {
      await highlighter.loadLanguage(targetLang as BundledLanguage);
    } catch {
      // Unknown grammar falls back gracefully to plain text
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

  // Maintain LRU bounded size
  if (highlightCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = highlightCache.keys().next().value;
    if (oldestKey !== undefined) {
      highlightCache.delete(oldestKey);
    }
  }

  highlightCache.set(cacheKey, { html });
  return html;
}
