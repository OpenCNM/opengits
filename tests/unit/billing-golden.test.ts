import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 资金面计费内核黄金对拍（D组端点5：/api/internal/job/settle 已下沉 Go
 * pgx 直写）。Node estimateRequiredCredits 仍承载估算路由——与 Go 结算
 * 共用数学，夹具双端同源断言。
 */
import { estimateRequiredCredits } from '@/lib/credits-config';

interface GoldenCase {
  name: string;
  config: Record<string, number>;
  input: { totalChars?: number; docCount?: number; isPublic?: boolean; isCodePedagogy?: boolean };
  expected: { estimatedChunks: number; baseCredits: number; finalCredits: number; rewardCredits: number };
}

function loadGolden(): GoldenCase[] {
  const raw = readFileSync(
    join(__dirname, '../../services/worker-sidecar/testdata/billing.golden.json'),
    'utf8'
  );
  const fixture = JSON.parse(raw) as { cases: GoldenCase[] };
  if (!fixture.cases?.length) throw new Error('billing.golden.json empty');
  return fixture.cases;
}

describe('1.17.4.2 billing golden parity（Node 估算路由 vs Go 结算内核 45 例黄金对拍）', () => {
  const cases = loadGolden();

  it.for(cases)('$# $name 与夹具一致', ({ config, input, expected }, { expect }) => {
    const got = estimateRequiredCredits(input, config);
    expect(got.estimatedChunks).toBe(expected.estimatedChunks);
    expect(got.baseCredits).toBe(expected.baseCredits);
    expect(got.finalCredits).toBe(expected.finalCredits);
    expect(got.rewardCredits).toBe(expected.rewardCredits);
  });
});
