/**
 * src/lib/update-market/gate.ts
 *
 * Deterministic quality and content gate (L0) for candidate transcription submissions.
 */

/** L0 门禁阈值（确定性产出验收；具名常量防内联魔法数） */
export const L0 = {
  minNewChars: 50,
  minRatio: 0.3,
  maxRatio: 5,
  cjkFloor: 0.1,
  cjkRetention: 0.7,
} as const;

/**
 * L0 确定性门禁：新转录产出的结构性验收（免费、必跑）。
 * 长度比坍缩/爆炸、标题结构缺失、目标语言占比显著下滑 → 拒绝暂存。
 */
export function l0Gate(newContent: string, oldContent: string | null): { passed: boolean; reason?: string } {
  if (!newContent || newContent.trim().length < L0.minNewChars) {
    return { passed: false, reason: '生成内容过短' };
  }
  const old = oldContent?.trim() ?? '';
  if (old.length > 0) {
    const ratio = newContent.length / old.length;
    if (ratio < L0.minRatio) return { passed: false, reason: `长度仅为旧版 ${Math.round(ratio * 100)}%（低于 30%）` };
    if (ratio > L0.maxRatio) return { passed: false, reason: `长度达旧版 ${Math.round(ratio)} 倍（超过 5 倍）` };
    const cjkRatio = (s: string) => (s.match(/[\u4e00-\u9fff]/g) || []).length / Math.max(1, s.length);
    if (cjkRatio(old) > L0.cjkFloor && cjkRatio(newContent) < cjkRatio(old) * L0.cjkRetention) {
      return { passed: false, reason: '中文占比显著低于旧版（语言不一致）' };
    }
  }
  if (!/^#{1,3} /m.test(newContent)) {
    return { passed: false, reason: '缺少标题结构' };
  }
  return { passed: true };
}
