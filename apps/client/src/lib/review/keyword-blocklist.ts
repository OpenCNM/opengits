// 平台内容安全关键词黑名单（发布初审的零成本裸防线）。
//
// 定位：LLM 初审的「不依赖任何模型」的硬防线——假端点可以伪造 LLM 判决，
// 但绕不过本文件里的子串匹配。命中 = 直接扣留人工（SAFETY_HOLD），不自动公开。
// 方向性说明：命中只转人工不复核驳回，误伤成本 = 一次人工审核，属安全方向。
// 词表维护：v1 内置基础词表（按类别集中注册，AGENTS.md 禁散落硬编码）；
// 后续如需运营热调，可迁入 admin 配置表，本文件的匹配函数无需变动。

export interface BlockedKeywordGroup {
  category: string;
  patterns: string[];
}

/** 基础词表：仅收录明确违法/明显违规类目，宁缺勿滥（误命中只多一次人工审核） */
export const BLOCKED_KEYWORD_GROUPS: readonly BlockedKeywordGroup[] = [
  {
    category: '赌博',
    patterns: ['博彩', '赌博网站', '赌场', '棋牌娱乐城', '六合彩', '老虎机', '网赌', '押注平台'],
  },
  {
    category: '毒品',
    patterns: ['冰毒', '摇头丸', '大麻种植', '制毒', '吸毒方法', '毒品购买'],
  },
  {
    category: '色情低俗',
    patterns: ['色情网站', '成人影片', '援交', '裸聊', '嫖娼', '卖淫'],
  },
  {
    category: '暴力恐怖',
    patterns: ['制造炸弹', '爆炸物制作', '枪支改装', '自杀教程', '恐怖袭击'],
  },
  {
    category: '诈骗钓鱼',
    patterns: ['钓鱼网站搭建', '电信诈骗话术', '杀猪盘', '洗钱教程', '传销组织', '非法集资话术'],
  },
  {
    category: '黑客攻击',
    patterns: ['ddos攻击教程', '勒索病毒制作', '盗号教程', '外挂制作', '入侵教程'],
  },
] as const;

export interface BlockedKeywordHit {
  category: string;
  keyword: string;
}

const MAX_REPORTED_HITS = 5;

// 零宽字符族：纯注入辅助字符，匹配前删除
const ZERO_WIDTH_AND_WS = /[\u200B\u200C\u200D\u2060\uFEFF\s]+/g;

/** 匹配口径归一化（红队 GAP-4）：NFKC 折叠全角/兼容形态 + 删零宽字符 + 删空白 + 小写。
 *  已知边界：繁简差异不做转换（需 s2t 词表，后续批次）。命中只转人工，误伤成本 = 一次人工审核。 */
function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ZERO_WIDTH_AND_WS, '')
    .toLowerCase();
}

/** 预归一化词表：模块加载时计算一次 */
const NORMALIZED_PATTERNS: Array<{ category: string; pattern: string }> =
  BLOCKED_KEYWORD_GROUPS.flatMap((group) =>
    group.patterns.map((pattern) => ({ category: group.category, pattern: normalizeForMatch(pattern) }))
  );

/** 纯函数：扫描文本集合，返回命中（按类别+关键词去重，最多上报 5 条防提示词爆炸） */
export function matchBlockedKeywords(texts: Array<string | null | undefined>): BlockedKeywordHit[] {
  const joined = texts
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .map(normalizeForMatch)
    .join('');

  if (!joined) return [];

  const hits: BlockedKeywordHit[] = [];
  const seen = new Set<string>();
  for (const { category, pattern } of NORMALIZED_PATTERNS) {
    const key = `${category}:${pattern}`;
    if (seen.has(key)) continue;
    if (pattern && joined.includes(pattern)) {
      seen.add(key);
      hits.push({ category, keyword: pattern });
      if (hits.length >= MAX_REPORTED_HITS) return hits;
    }
  }
  return hits;
}
