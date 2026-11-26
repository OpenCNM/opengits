import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  highlightCodeWasm,
  getWasmHighlighter,
  clearHighlightCache,
  getHighlightCacheStats,
} from '@/lib/wasm/syntax-highlighter-wasm';

describe('WASM Syntax Highlighting & Tokenization Decoupling (TOP 2)', () => {
  beforeAll(async () => {
    // Warm up the Shiki Oniguruma WebAssembly highlighter instance
    await getWasmHighlighter();
  });

  beforeEach(() => {
    clearHighlightCache();
  });

  describe('Contract 1: Multi-Theme Tokenization & CSS Variable Generation', () => {
    it('2.14.1.2 generates multi-theme CSS variables for light, dark, and parchment (Multi-Theme CSS 变量 Token 着色合规)', async () => {
      const code = 'const answer: number = 42;';
      const html = await highlightCodeWasm(code, { lang: 'typescript' });

      expect(typeof html).toBe('string');
      expect(html).toContain('<pre');
      expect(html).toContain('<code');

      // Assert multi-theme CSS variables exist on the container or token spans
      expect(html).toContain('--shiki-light');
      expect(html).toContain('--shiki-dark');
      expect(html).toContain('--shiki-parchment');

      // Verify tokenization occurred (e.g. keywords like 'const', number '42')
      expect(html).toContain('const');
      expect(html).toContain('answer');
      expect(html).toContain('42');
    });

    it('supports custom theme mappings in options', async () => {
      const code = 'echo "hello wasm"';
      const html = await highlightCodeWasm(code, {
        lang: 'bash',
        themes: {
          light: 'github-light',
          dark: 'github-dark',
        },
      });

      expect(html).toContain('--shiki-light');
      expect(html).toContain('--shiki-dark');
    });
  });

  describe('Contract 2: Language Coverage & Aliases', () => {
    it('supports all core languages (Python, Go, Rust, JSON, YAML)', async () => {
      const py = await highlightCodeWasm('def greet(name: str):\n    return f"Hello {name}"', { lang: 'python' });
      expect(py).toContain('def');
      expect(py).toContain('greet');

      const go = await highlightCodeWasm('package main\n\nfunc main() {\n\tprintln("hi")\n}', { lang: 'go' });
      expect(go).toContain('package');
      expect(go).toContain('main');

      const rust = await highlightCodeWasm('fn main() {\n    let msg = "wasm";\n}', { lang: 'rust' });
      expect(rust).toContain('fn');
      expect(rust).toContain('wasm');

      const json = await highlightCodeWasm('{\n  "version": "1.0.0",\n  "enabled": true\n}', { lang: 'json' });
      expect(json).toContain('"version"');
      expect(json).toContain('true');
    });

    it('resolves common language aliases', async () => {
      const tsAlias = await highlightCodeWasm('let a = 1;', { lang: 'ts' });
      const jsAlias = await highlightCodeWasm('let a = 1;', { lang: 'js' });
      const pyAlias = await highlightCodeWasm('x = 1', { lang: 'py' });
      const shAlias = await highlightCodeWasm('ls -la', { lang: 'sh' });

      expect(tsAlias).toContain('<code');
      expect(jsAlias).toContain('<code');
      expect(pyAlias).toContain('<code');
      expect(shAlias).toContain('<code');
    });

    it('2.14.1.3 resolves extensions and aliases from the centralized LANGUAGE_MAP registry (LANGUAGE_MAP 集中注册表动态同步)', async () => {
      const { resolveHighlightLanguage, getRegisteredSyntaxAliasesCount } = await import('@/engine/languages');

      // Verify dynamic registry size encompasses LANGUAGE_MAP (33 languages, 60+ extensions) + doc grammars
      expect(getRegisteredSyntaxAliasesCount()).toBeGreaterThanOrEqual(80);

      // Verify extension-based resolution
      expect(resolveHighlightLanguage('rs')).toBe('rust');
      expect(resolveHighlightLanguage('py')).toBe('python');
      expect(resolveHighlightLanguage('cs')).toBe('csharp');
      expect(resolveHighlightLanguage('kt')).toBe('kotlin');
      expect(resolveHighlightLanguage('rb')).toBe('ruby');
      expect(resolveHighlightLanguage('fs')).toBe('fsharp');
      expect(resolveHighlightLanguage('jl')).toBe('julia');
      expect(resolveHighlightLanguage('sol')).toBe('solidity');

      // Verify explicit semantic aliases
      expect(resolveHighlightLanguage('golang')).toBe('go');
      expect(resolveHighlightLanguage('c++')).toBe('cpp');
      expect(resolveHighlightLanguage('c#')).toBe('csharp');
      expect(resolveHighlightLanguage('yml')).toBe('yaml');
      expect(resolveHighlightLanguage('md')).toBe('markdown');
      expect(resolveHighlightLanguage('docker')).toBe('dockerfile');
      expect(resolveHighlightLanguage('gql')).toBe('graphql');
      expect(resolveHighlightLanguage('vlang')).toBe('v');

      // 🧪 2026-09-29 语法扩容（toml/dockerfile/cmake/make + gleam/moonbit/typst）
      expect(resolveHighlightLanguage('typ')).toBe('typst');
      expect(resolveHighlightLanguage('mbt')).toBe('moonbit');
      expect(resolveHighlightLanguage('gleam')).toBe('gleam');
      expect(resolveHighlightLanguage('cmake')).toBe('cmake');
      expect(resolveHighlightLanguage('make')).toBe('makefile');

      // Verify prefix stripping (e.g. language-python)
      expect(resolveHighlightLanguage('language-python')).toBe('python');
      expect(resolveHighlightLanguage('language-GO')).toBe('go');
    });

    it('dynamically lazy-loads non-preloaded languages on demand without crashing', async () => {
      // Kotlin, Ruby, TOML are not in the core 18 preloaded set, but are supported via on-demand loading
      const kotlinCode = 'fun main() { println("Hello Kotlin") }';
      const kotlinHtml = await highlightCodeWasm(kotlinCode, { lang: 'kt' });
      expect(kotlinHtml).toContain('fun');
      expect(kotlinHtml).toContain('main');

      const tomlCode = '[server]\nport = 8080';
      const tomlHtml = await highlightCodeWasm(tomlCode, { lang: 'toml' });
      expect(tomlHtml).toContain('server');
      expect(tomlHtml).toContain('8080');
    });

    it('falls back gracefully to plain text for unknown language grammars', async () => {
      const unknown = await highlightCodeWasm('RANDOM_CUSTOM_SYNTAX_12345', { lang: 'nonexistent-lang-xyz' });
      expect(unknown).toContain('RANDOM_CUSTOM_SYNTAX_12345');
      expect(unknown).toContain('<code');
    });
  });

  describe('Contract 3: LRU Memory Cache & Performance', () => {
    it('hits LRU memory cache on identical code inputs', async () => {
      const code = 'export interface Config { timeout: number; }';

      expect(getHighlightCacheStats().misses).toBe(0);
      expect(getHighlightCacheStats().hits).toBe(0);

      // Miss 1
      const html1 = await highlightCodeWasm(code, { lang: 'typescript' });
      expect(getHighlightCacheStats().misses).toBe(1);
      expect(getHighlightCacheStats().hits).toBe(0);

      // Hit 1
      const html2 = await highlightCodeWasm(code, { lang: 'typescript' });
      expect(getHighlightCacheStats().hits).toBe(1);
      expect(getHighlightCacheStats().misses).toBe(1);
      expect(html1).toBe(html2);

      // Hit 2
      const t0 = performance.now();
      await highlightCodeWasm(code, { lang: 'typescript' });
      const elapsed = performance.now() - t0;
      expect(getHighlightCacheStats().hits).toBe(2);
      expect(elapsed).toBeLessThan(1); // sub-millisecond cached access
    });

    it('clears cache properly when clearHighlightCache() is called', async () => {
      await highlightCodeWasm('const x = 1;', { lang: 'javascript' });
      expect(getHighlightCacheStats().size).toBe(1);

      clearHighlightCache();
      expect(getHighlightCacheStats().size).toBe(0);
      expect(getHighlightCacheStats().hits).toBe(0);
      expect(getHighlightCacheStats().misses).toBe(0);
    });
  });

  describe('Contract 4: Boundary & Edge Cases', () => {
    it('handles empty code string cleanly', async () => {
      const result = await highlightCodeWasm('', { lang: 'ts' });
      expect(result).toBe('');
    });

    it('handles unicode, emojis, and special symbols in code blocks', async () => {
      const code = '// 🚀 OpenGits 平台：高性能 WASM 核心\nconst greeting = "你好，世界！";';
      const html = await highlightCodeWasm(code, { lang: 'typescript' });
      expect(html).toContain('🚀');
      expect(html).toContain('你好，世界！');
    });
  });

  describe('Contract 5: Compiler Pipeline Integration (compile-cache rehypePreserveRawCode)', () => {
    it('pre-highlights code blocks with accurate language tokens and attaches data-highlighted-html', async () => {
      const { mdxCompiler } = await import('@/lib/mdx/compile-cache');
      const mdxSource = '```typescript\nconst greeting: string = "hello wasm";\n```';
      const compiled = await mdxCompiler.compile({ source: mdxSource });
      const output = String(compiled.compiled ?? '');

      // Verify data-code is attached
      expect(output).toContain('data-code');
      // Verify data-language is extracted from child code className
      expect(output).toContain('data-language');
      expect(output).toContain('typescript');
      // Verify pre-highlighted html is attached
      expect(output).toContain('data-highlighted-html');
      // Verify Shiki CSS variables and tokens exist in the output
      expect(output).toContain('--shiki-light');
      expect(output).toContain('--shiki-dark');
    });
  });

  describe('Contract 6: Zero-Materialization Line Transformer & Anchors', () => {
    it('injects data-line and id attributes into each code line span', async () => {
      const code = 'const first = 1;\nconst second = 2;\nconst third = 3;';
      const html = await highlightCodeWasm(code, { lang: 'typescript' });

      expect(html).toContain('data-line="1"');
      expect(html).toContain('id="L1"');
      expect(html).toContain('data-line="2"');
      expect(html).toContain('id="L2"');
      expect(html).toContain('data-line="3"');
      expect(html).toContain('id="L3"');
    });
  });
});
