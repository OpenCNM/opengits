export interface BlockedKeywordGroup {
  category: string;
  patterns: string[];
}

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

const ZERO_WIDTH_AND_WS = /[\u200B\u200C\u200D\u2060\uFEFF\s]+/g;

function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ZERO_WIDTH_AND_WS, '')
    .toLowerCase();
}

const NORMALIZED_PATTERNS: Array<{ category: string; pattern: string }> =
  BLOCKED_KEYWORD_GROUPS.flatMap((group) =>
    group.patterns.map((pattern) => ({ category: group.category, pattern: normalizeForMatch(pattern) }))
  );

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
