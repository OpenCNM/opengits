import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Wire Envelope Golden（Go ↔ TS 信封契约对拍，TS 侧）：
 *
 * 夹具由 Go 侧 services/worker-sidecar/wire_envelope_golden_test.go 用反射
 * 填充确定性代表值后 marshal 生成（29 个 /v1/* 端点响应信封形状）。
 * 本测试用 Zod 消费同一份夹具，schema 按「TS driver 实际消费的字段」编写——
 * Go 改响应字段名/形状 → 夹具重生成后本测试红；TS 改消费契约 → 本测试红。
 * 契约变更必须两侧同步：go test -run TestWireEnvelopeGolden -update 重新生成
 * 夹具 + 更新本文件 schema，缺一不可。
 *
 * 纯函数级对拍见 golden-parity.test.ts；本文件只锁 HTTP 信封形状
 * （纯函数测试对 handler 改字段名是无感的，那正是本测试存在的理由）。
 */

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../services/worker-sidecar/testdata/wire-envelope.golden.json'), 'utf8')
) as { version: number; endpoints: Record<string, unknown> };

const optionalStr = z.string().optional().nullable();
const strArray = z.array(z.string());
const looseRecord = z.record(z.string(), z.unknown());

/** TS driver 消费的信封契约登记表（新增 Go 端点必须在 Go 测试表与本表同步登记）。 */
const envelopeSchemas: Record<string, z.ZodType> = {
  '/v1/chunk/markdown': z.object({
    chunks: z.array(z.object({ heading: z.string(), content: z.string(), headingPath: optionalStr })),
  }),
  '/v1/chunk/code-module': z.object({ chunks: z.array(looseRecord) }),
  '/v1/outline/candidates': z.object({
    ok: z.boolean(),
    candidates: z.array(
      z.object({
        path: z.string(),
        handle: z.number(),
        isDoc: z.boolean(),
        weight: z.number(),
        anchor: optionalStr,
        kind: optionalStr,
        detail: optionalStr,
      })
    ),
  }),
  '/v1/outline/rule-fallback': z.object({
    ok: z.boolean(),
    chapters: z.array(z.object({ name: z.string(), summary: z.string(), files: z.array(z.object({ path: z.string(), shortTitle: z.string() })) })),
  }),
  '/v1/outline/sanitize': z.object({
    ok: z.boolean(),
    sanitizedChapters: z.array(z.object({ name: z.string(), summary: z.string() })),
    sanitizedModules: z.array(z.object({ name: z.string(), summary: z.string() })),
    droppedPaths: strArray,
  }),
  '/v1/outline/prepare-signals': z.object({
    ok: z.boolean(),
    candidates: z.array(
      z.object({
        path: z.string(),
        handle: z.number(),
        isDoc: z.boolean(),
        anchor: optionalStr,
        kind: optionalStr,
        detail: optionalStr,
      })
    ),
    fileCount: z.number(),
    isFlat: z.boolean(),
    flatRepoHints: z.string(),
  }),
  '/v1/mdx/heal': z.object({ ok: z.boolean(), content: z.string() }),
  '/v1/mdx/sanitize': z.object({ ok: z.boolean(), content: z.string() }),
  '/v1/mdx/validate': z.object({ ok: z.boolean(), valid: z.boolean(), error: optionalStr }),
  '/v1/archive/tree': z.object({ ok: z.boolean(), nodes: z.array(z.object({ path: z.string(), type: z.string() })) }),
  '/v1/archive/sniff': z.object({ ok: z.boolean(), profile: looseRecord }),
  '/v1/archive/ensure': z.object({ dir: z.string().nullable(), fromCache: z.boolean() }),
  '/v1/archive/diff': z.object({
    added: strArray,
    modified: strArray,
    removed: strArray,
    renamed: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
  '/v1/update/candidate-set': z.object({
    chapters: z.array(
      z.object({ path: z.string(), title: z.string(), change: z.string(), isBreaking: z.boolean() })
    ),
    diffStats: z.object({ added: z.number(), modified: z.number() }),
  }),
  '/v1/web-doc/diff': z.object({
    hasChanges: z.boolean(),
    pagesToAdd: strArray,
    pagesToRemove: strArray,
    pagesToUpdate: strArray,
    totalChanged: z.number(),
    totalPages: z.number(),
  }),
  '/v1/graph/symbol-lookup': z.object({
    ok: z.boolean(),
    found: z.boolean(),
    symbol: z.object({ name: z.string(), file: z.string(), kind: z.string() }).nullable(),
    error: optionalStr,
  }),
  '/v1/graph/concept-grounding': z.object({
    ok: z.boolean(),
    goldenSymbols: z.array(z.object({ name: z.string(), file: z.string(), kind: z.string() })),
    backboneFiles: z.array(z.object({ path: z.string(), role: z.string() })),
    error: optionalStr,
  }),
  '/v1/symbols/extract': z.object({
    ok: z.boolean(),
    symbols: z.array(z.object({ name: z.string(), kind: z.string(), exported: z.boolean() })),
    imports: z.array(z.object({ module: z.string() })),
    callSites: z.array(z.object({ name: z.string() })),
    referencedConstants: strArray,
  }),

  '/v1/fingerprint/compute': z.object({
    ok: z.boolean(),
    result: z.object({ overallProgress: z.number(), effectivelyRead: z.number() }),
  }),
  '/v1/fingerprint/compute-batch': z.object({ ok: z.boolean(), results: z.record(z.string(), looseRecord) }),
};

describe('Wire Envelope Golden（Go ↔ TS 信封契约对拍）', () => {
  it('夹具端点与 TS 契约登记表一一对应（新增端点必须双侧登记）', () => {
    expect(Object.keys(fixture.endpoints).sort()).toEqual(Object.keys(envelopeSchemas).sort());
  });

  it('夹具版本号受控（结构性变更需显式升版）', () => {
    expect(fixture.version).toBe(1);
  });

  for (const [endpoint, schema] of Object.entries(envelopeSchemas)) {
    it(`${endpoint} 信封契约不漂移`, () => {
      const parsed = schema.safeParse(fixture.endpoints[endpoint]);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        throw new Error(
          `${endpoint} 信封漂移 [${issues}] — 若为 Go 侧有意变更：` +
            `go test -run TestWireEnvelopeGolden -update 重新生成夹具，并同步更新本文件 schema`
        );
      }
    });
  }
});
