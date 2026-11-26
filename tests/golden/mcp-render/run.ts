/**
 * Golden Diff runner for MCP tool result rendering (`renderToolResult`).
 *
 * - Cases with `{ "fixturePath": "..." }` run all cases in the shared Go/TS parity
 *   fixture (e.g. `services/worker-sidecar/testdata/mcp-tool-output.golden.json`),
 *   asserting exact byte-for-byte parity with `wantText`.
 * - Cases with `{ "ctxFlags": ..., "result": ... }` return the rendered text directly
 *   for line-by-line unified diffing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToolResult, type RepoContext, type ToolResult } from '@/lib/mcp/tools/shared';

export const defaultExt = '.txt';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface CtxFlags {
  fallback?: boolean;
  requestedEdition?: string;
  edition?: string;
  editionLabel?: string;
  nullCtx?: boolean;
}

interface SingleCaseInput {
  ctxFlags?: CtxFlags;
  result: ToolResult;
}

interface ParityFixtureInput {
  fixturePath: string;
}

function buildCtx(flags: CtxFlags = {}): RepoContext | null {
  if (flags.nullCtx) return null;
  return {
    owner: 'acme',
    repo: 'calculator',
    repository: { id: 'repo-1' },
    isFallback: flags.fallback,
    requestedEdition: flags.requestedEdition,
    edition: flags.edition ?? '',
    editionLabel: flags.editionLabel,
  };
}

export async function run(input: string): Promise<string> {
  const parsed = JSON.parse(input) as SingleCaseInput | ParityFixtureInput;

  if ('fixturePath' in parsed) {
    const absPath = path.resolve(REPO_ROOT, parsed.fixturePath);
    const fixture = JSON.parse(fs.readFileSync(absPath, 'utf8')) as {
      cases: Array<{ name: string; ctxFlags: CtxFlags; result: ToolResult; wantText: string }>;
    };
    if (!fixture.cases || fixture.cases.length === 0) {
      throw new Error(`Parity fixture is empty: ${parsed.fixturePath}`);
    }

    const summary = fixture.cases.map((tc) => {
      const got = renderToolResult(tc.result, buildCtx(tc.ctxFlags));
      if (got !== tc.wantText) {
        throw new Error(
          `Parity mismatch on case "${tc.name}":\nexpected: ${JSON.stringify(tc.wantText)}\nactual:   ${JSON.stringify(got)}`,
        );
      }
      return {
        name: tc.name,
        bytes: Buffer.byteLength(got, 'utf8'),
        parityMatch: true,
      };
    });

    return `${JSON.stringify({ fixturePath: parsed.fixturePath, caseCount: summary.length, cases: summary }, null, 2)}\n`;
  }

  return renderToolResult(parsed.result, buildCtx(parsed.ctxFlags));
}
