import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * prepare 指纹黄金夹具对拍（D组端点3：/api/internal/doc/prepare 已下沉 Go
 * runPrepare 单实现）。Node 侧 fingerprintInputsFor + computeRequestFingerprint
 * 仍是 JIT / server-gate / 直连 submit 的生产者——两侧必须产出同一指纹
 * （互命中零 LLM 复用的根基），夹具双端同源断言。
 */
import { fingerprintInputsFor } from '@/lib/transcription/fingerprint';
import { computeRequestFingerprint } from '@/lib/content-addressing';

interface GoldenCase {
  name: string;
  doc: {
    repositoryId: string;
    path: string;
    gitSha: string | null;
    repoProfile: Record<string, unknown>;
  };
  model: string;
  options: Record<string, unknown>;
  expectedInputs: Record<string, unknown>;
  expectedFingerprint: string;
}

function loadGolden(): GoldenCase[] {
  const raw = readFileSync(
    join(__dirname, '../../services/worker-sidecar/testdata/mdx-fingerprint.golden.json'),
    'utf8'
  );
  const fixture = JSON.parse(raw) as { cases: GoldenCase[] };
  if (!fixture.cases?.length) throw new Error('mdx-fingerprint.golden.json empty');
  return fixture.cases;
}

function makeCtx(d: GoldenCase['doc']) {
  return {
    id: 'doc-1',
    repositoryId: d.repositoryId,
    path: d.path,
    title: 'T',
    content: null,
    status: 'UNPROCESSED',
    ownerUserId: null,
    repository: { owner: 'o', repo: 'r', branch: 'main', gitSha: d.gitSha, repoProfile: d.repoProfile },
  };
}

describe('mdx-fingerprint golden parity（Node 生产者 vs Go prepare 单实现）', () => {
  // 2.12.13.1 computeRequestFingerprint 13 例双端同源断言
  // 2.12.13.2 LoadActiveUserModelId 零密钥字段
  // 2.12.13.3 指纹命中复用链三件套
  const cases = loadGolden();

  it.for(cases)('$# $name 指纹输入与哈希均与夹具一致', ({ doc, model, options, expectedInputs, expectedFingerprint }, { expect }) => {
    const inputs = fingerprintInputsFor(makeCtx(doc) as never, model, options as never);
    const filtered = Object.fromEntries(
      Object.entries(inputs).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
    expect(filtered).toEqual(expectedInputs);
    expect(computeRequestFingerprint(inputs)).toBe(expectedFingerprint);
  });
});
