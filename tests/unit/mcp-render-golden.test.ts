import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToolResult } from '@/lib/mcp/tools/shared';

/** TS/Go 渲染孪生黄金对拍（TS 侧）：与 internal/mcp/render_pipeline_test.go 跑同一夹具 */
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../services/worker-sidecar/testdata/mcp-tool-output.golden.json'), 'utf8')
) as { cases: Array<{ name: string; ctxFlags: any; result: any; wantText: string }> };

describe('MCP 渲染层黄金对拍（TS 侧）', () => {
  it('夹具非空且全用例逐字节一致', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const tc of fixture.cases) {
      const ctx = {
        owner: 'acme',
        repo: 'calculator',
        repository: { id: 'repo-1' },
        isFallback: tc.ctxFlags.fallback,
        requestedEdition: tc.ctxFlags.requestedEdition,
        edition: tc.ctxFlags.edition ?? '',
        editionLabel: tc.ctxFlags.editionLabel,
      } as any;
      const got = renderToolResult(tc.result, ctx);
      expect(got, `case ${tc.name}`).toBe(tc.wantText);
    }
  });
});
