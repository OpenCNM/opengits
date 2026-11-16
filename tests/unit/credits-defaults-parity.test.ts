// credits 兜底常量双端锁步门禁：
// Go jobs/settle.go creditsConfigDefaults 与 TS credits-config.ts CREDITS_CONFIG 是
// 手抄镜像（DB 缺省兜底），此前无任何门禁看守（schema-drift 管 SQL、golden 管 MCP，
// 这对常量裸奔）。本用例直接解析 Go 源字面量与 TS 常量对拍——任一侧单方改动即红。
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDITS_CONFIG } from '@/lib/credits-config';

const SETTLE_GO = join(
  __dirname,
  '../../services/worker-sidecar/internal/jobs/settle.go'
);

function goDefaults(): Record<string, number | boolean> {
  const src = readFileSync(SETTLE_GO, 'utf-8');
  const m = src.match(/creditsConfigDefaults = settleCreditsDefaults\{([\s\S]*?)\n\}/);
  if (!m) throw new Error('settle.go: creditsConfigDefaults 块未找到——若已重构请同步本对拍');
  const out: Record<string, number | boolean> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*(\w+):\s+(-?[\d.]+|true|false),/);
    if (kv) out[kv[1]] = kv[2] === 'true' || kv[2] === 'false' ? kv[2] === 'true' : Number(kv[2]);
  }
  return out;
}

test('Go settle 兜底常量与 TS CREDITS_CONFIG 双端零漂移', () => {
  const go = goDefaults();
  const pairs: Array<[keyof typeof CREDITS_CONFIG, string]> = [
    ['DEFAULT_DAILY_CREDITS', 'defaultDailyCredits'],
    ['DEFAULT_RESET_INTERVAL_HOURS', 'resetIntervalHours'],
    ['MAX_CREDITS_PER_IMPORT', 'maxCreditsPerImport'],
    ['STANDARD_CHUNK_CHAR_SIZE', 'standardChunkCharSize'],
    ['CODE_PEDAGOGY_MULTIPLIER', 'codePedagogyMulti'],
    ['PUBLISH_GIFT_ENABLED', 'publishGiftEnabled'],
  ];
  // 双端字段齐全性：任一侧增删兜底字段必须同步本对拍表
  expect(Object.keys(go).sort()).toEqual(pairs.map(([, g]) => g).sort());
  for (const [tsKey, goKey] of pairs) {
    expect(go[goKey], `Go ${goKey} <-> TS ${tsKey}`).toBe(CREDITS_CONFIG[tsKey]);
  }
});
