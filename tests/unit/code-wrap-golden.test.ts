import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 代码包壳黄金对拍（D组端点4：/api/internal/doc/transform 已下沉 Go 抓取链）。
 * Node wrapCodeAsMdx 仍是 fetcher.ts / archive-store 回源链的实现——
 * 与 Go transform_fetch.go 共用语义，夹具双端同源断言。
 */
import { wrapCodeAsMdx } from '@/engine/code-to-mdx';

interface GoldenCase {
  name: string;
  filePath: string;
  raw: string;
  expected: string;
}

function loadGolden(): GoldenCase[] {
  const raw = readFileSync(
    join(__dirname, '../../services/worker-sidecar/testdata/code-wrap.golden.json'),
    'utf8'
  );
  const fixture = JSON.parse(raw) as { cases: GoldenCase[] };
  if (!fixture.cases?.length) throw new Error('code-wrap.golden.json empty');
  return fixture.cases;
}

// 🧪 向量 2.15.7.2: wrapCodeAsMdx 围栏长度=内容最长反引号串+1，code-wrap.golden.json 双端对拍（含三/四反引号内容用例）
describe('code-wrap golden parity（Node fetcher 链 vs Go 抓取链）', () => {
  const cases = loadGolden();

  it.for(cases)('$# $name 与夹具一致', ({ filePath, raw, expected }, { expect }) => {
    expect(wrapCodeAsMdx(filePath, raw)).toBe(expected);
  });
});
