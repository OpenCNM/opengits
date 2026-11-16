import { describe, expect, it } from 'vitest';
import { matchBlockedKeywords } from '@/lib/review/keyword-blocklist';

/**
 * 关键词黑名单匹配回归（红队 GAP-4 修复）：
 * 归一化口径 = NFKC + 剥零宽字符族 + 删空白 + 小写。
 * 已知边界（有意不做）：繁简转换需 s2t 词表，后续批次。
 */
describe('matchBlockedKeywords（关键词黑名单归一化匹配）', () => {
  it('普通命中：简体原文直接匹配', () => {
    const hits = matchBlockedKeywords(['本文介绍赌博网站的搭建']);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].category).toBe('赌博');
  });

  it('零宽字符插入不再绕过（红队 GAP-4 前形态）', () => {
    expect(matchBlockedKeywords(['博\u200B彩'])).toHaveLength(1);
    expect(matchBlockedKeywords(['赌博\uFEFF网站'])).toHaveLength(1);
  });

  it('空白插入不再绕过', () => {
    expect(matchBlockedKeywords(['博 彩 平台'])).toHaveLength(1);
    expect(matchBlockedKeywords(['电信 诈 骗 话 术'])).toHaveLength(1);
  });

  it('NFKC 折叠全角形态', () => {
    expect(matchBlockedKeywords(['ＢＯＣＡＩ'])).toHaveLength(0); // 词表无拉丁词，仅验证不误伤
    expect(matchBlockedKeywords(['制毒流程：ＩＣＥ'])).toHaveLength(1); // 全角 ICE → ICE 命中制毒类
  });

  it('无命中文本返回空且不误伤正常教程用语', () => {
    expect(matchBlockedKeywords(['本节讲解 React 状态管理与性能优化'])).toHaveLength(0);
  });

  it('命中数上限钳制在 5 条', () => {
    const hits = matchBlockedKeywords(['赌博 博彩 冰毒 摇头丸 色情网站 援交 裸聊']);
    expect(hits.length).toBeLessThanOrEqual(5);
  });
});
