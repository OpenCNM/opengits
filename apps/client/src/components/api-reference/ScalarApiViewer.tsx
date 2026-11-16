'use client';

import React, { useMemo } from 'react';
import { useReaderAppearanceStore } from '@/lib/stores/reader-appearance-store';
import { cn } from '@/lib/utils';

/**
 * 嵌入 Scalar API 交互视窗组件
 * 
 * 依赖上游契约：@scalar/api-reference@1.25.109
 * 安全不变量：
 * 1. 严格使用沙箱且严禁 `allow-same-origin`，以 opaque origin (null) 隔离执行第三方 CDN 脚本与外部 OpenAPI 文档。
 * 2. 避免大体积 SpecRaw 多重序列化，优先使用 `specUrl`（如本域代理路由 /api/repos/[owner]/[repo]/openapi）驱动。
 */
export interface ScalarApiViewerProps {
  spec?: Record<string, unknown> | string;
  className?: string;
  specUrl?: string;
}

export function ScalarApiViewer({ spec, className, specUrl }: ScalarApiViewerProps) {
  const currentTheme = useReaderAppearanceStore((s) => s.theme);
  const isDark = currentTheme === 'dark';

  const srcDoc = useMemo(() => {
    const config = {
      spec: specUrl
        ? { url: specUrl }
        : typeof spec === 'string'
        ? { content: spec }
        : { content: spec || {} },
      darkMode: isDark,
      layout: 'modern',
      showSidebar: false,
      hideDarkModeToggle: true,
      theme: 'default',
    };

    return `<!DOCTYPE html>
<html class="${isDark ? 'dark' : 'light'}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        min-height: 100vh;
        background: transparent;
      }
    </style>
  </head>
  <body>
    <script id="api-reference" type="application/json">
      ${JSON.stringify(config).replace(/</g, '\\u003c')}
    </script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.109"></script>
  </body>
</html>`;
  }, [spec, specUrl, isDark]);

  return (
    <div className={cn("scalar-reference-wrapper w-full h-[85vh] min-h-[700px] overflow-hidden rounded-xl border border-theme-border/60 bg-theme-surface/30 my-4 shadow-sm", className)}>
      <iframe
        srcDoc={srcDoc}
        title="Scalar 1:1 API Reference"
        className="w-full h-full border-none bg-transparent"
        sandbox="allow-scripts allow-popups allow-forms allow-downloads"
      />
    </div>
  );
}

export default ScalarApiViewer;
