import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ScalarApiViewer } from '@/components/api-reference/ScalarApiViewer';

vi.mock('@/lib/stores/reader-appearance-store', () => ({
  useReaderAppearanceStore: (selector: any) => selector({ theme: 'dark' }),
}));

describe('ScalarApiViewer component', () => {
  it('renders strictly sandboxed iframe without allow-same-origin and with pinned CDN', () => {
    const html = renderToString(
      React.createElement(ScalarApiViewer, {
        spec: {
          openapi: '3.1.0',
          info: { title: 'Test <script>alert(1)</script> API' },
        },
      })
    );

    expect(html).toContain('iframe');
    expect(html).toContain('title="Scalar 1:1 API Reference"');
    // F1 核心安全不变量：严禁包含 allow-same-origin，以 opaque origin 彻底隔离
    expect(html).not.toContain('allow-same-origin');
    expect(html).toContain('sandbox="allow-scripts allow-popups allow-forms allow-downloads"');
    expect(html).toContain('border-theme-border/60');
    expect(html).toContain('bg-theme-surface/30');
    // F7 核心供应链不变量：CDN 脚本必须锁定确定版本
    expect(html).toContain('cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.109');
    // XSS 防护：< 转义为 \u003c
    expect(html).toContain('\\u003cscript');
  });

  it('supports specUrl mode for Zero-Materialization without embedding giant spec', () => {
    const html = renderToString(
      React.createElement(ScalarApiViewer, {
        specUrl: '/api/repos/web-docs/petstore/openapi',
      })
    );

    expect(html).toContain('iframe');
    expect(html).toContain('/api/repos/web-docs/petstore/openapi');
    expect(html).not.toContain('allow-same-origin');
  });
});
