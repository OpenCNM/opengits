import { test, expect, describe } from 'vitest';
import {
  isIngestModeGrayZone,
  type RepoProfile,
} from '@/engine/repo-sniffer';
import {
  buildDirEvidence,
  deriveArbitratedProfile,
  type ArbitrationVerdict,
} from '@/lib/scout/pipeline/ingest-mode-arbiter';

/** 最小合法 RepoProfile 夹具（灰区判定只消费 ingestMode + docCodeRatio） */
function makeProfile(patch: Partial<RepoProfile> = {}): RepoProfile {
  return {
    repoType: 'docs',
    tier: 'B',
    ingestMode: 'text_only',
    docCodeRatio: {
      docFiles: 144,
      codeFiles: 127,
      otherFiles: 21,
      totalFiles: 842,
      ratio: 0.5314,
      codeExtensions: { '.ts': 108, '.mjs': 13 },
      docExtensions: { '.md': 45, '.mdx': 94 },
      codeBytes: 5 * 1024 * 1024,
      docBytes: 900 * 1024,
    },
    textRoot: 'docs/',
    labRoots: [],
    chapterCount: 0,
    hasTranslations: false,
    translationRoots: [],
    excludeFromNav: [],
    globalAssets: { pdfs: [], buildScripts: [] },
    answerFile: null,
    semanticTags: {},
  } as unknown as RepoProfile;
}

const CODE_VERDICT: ArbitrationVerdict = {
  teachingFocus: 'code',
  rationale: 'packages/core 等产品源码目录构成主体，docs/ 为平铺使用手册',
};
const DOCS_VERDICT: ArbitrationVerdict = {
  teachingFocus: 'docs',
  rationale: 'chapter-01 等章节目录构成主体，代码为各章配套实验',
};

describe('isIngestModeGrayZone（快筛：物理质量闸门）', () => {
  test('cline 形态：text_only + 127 代码文件 + 5MB 代码 → 灰区', () => {
    expect(isIngestModeGrayZone(makeProfile())).toBe(true);
  });

  test('书籍仓形态：30 个小示例文件共 80KB → 非灰区（规则直判，零 LLM）', () => {
    const p = makeProfile();
    p.docCodeRatio.codeFiles = 30;
    p.docCodeRatio.codeBytes = 80 * 1024;
    expect(isIngestModeGrayZone(p)).toBe(false);
  });

  test('代码文件够多但质量不足（20 文件共 100KB）→ 非灰区', () => {
    const p = makeProfile();
    p.docCodeRatio.codeFiles = 20;
    p.docCodeRatio.codeBytes = 100 * 1024;
    expect(isIngestModeGrayZone(p)).toBe(false);
  });

  test('质量够但文件数不足（10 文件共 1MB 打包产物形态）→ 非灰区', () => {
    const p = makeProfile();
    p.docCodeRatio.codeFiles = 10;
    p.docCodeRatio.codeBytes = 1024 * 1024;
    expect(isIngestModeGrayZone(p)).toBe(false);
  });

  test('文档不足 5 篇（override 3.5 本就不生效）→ 非灰区', () => {
    const p = makeProfile();
    p.docCodeRatio.docFiles = 3;
    expect(isIngestModeGrayZone(p)).toBe(false);
  });

  test('非 text_only 裁定（hybrid/code_only）→ 非灰区', () => {
    const p = makeProfile();
    p.ingestMode = 'hybrid';
    expect(isIngestModeGrayZone(p)).toBe(false);
  });

  test('旧画像 JSON 缺省 codeBytes → 按 0 处理，非灰区（向后兼容）', () => {
    const p = makeProfile();
    delete p.docCodeRatio.codeBytes;
    expect(isIngestModeGrayZone(p)).toBe(false);
  });
});

describe('deriveArbitratedProfile（裁决派生：确定性收敛）', () => {
  test('teachingFocus=code → hybrid + codebase + 清空 textRoot（目录首选回到仓库根，防 scope 锁死 docs 子树）', () => {
    const out = deriveArbitratedProfile(makeProfile(), CODE_VERDICT);
    expect(out.ingestMode).toBe('hybrid');
    expect(out.repoType).toBe('codebase');
    expect(out.textRoot).toBe('');
  });

  test('teachingFocus=docs → 原样保持 text_only（书籍仓保护经意图确认成立）', () => {
    const src = makeProfile();
    const out = deriveArbitratedProfile(src, DOCS_VERDICT);
    expect(out).toBe(src);
    expect(out.ingestMode).toBe('text_only');
  });
});

describe('仲裁缓存 TTL 分级（稳定性：瞬时故障不得放大为长期错误分类）', () => {
  test('成功 24h 不重烧，失败仅 5 分钟防抖（量级契约防回归）', async () => {
    const mod = await import('@/lib/scout/pipeline/ingest-mode-arbiter');
    expect(mod.ARBITRATION_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(mod.ARBITRATION_FAILURE_TTL_MS).toBeGreaterThan(0);
    expect(mod.ARBITRATION_FAILURE_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});

describe('buildDirEvidence（目录证据表）', () => {
  test('浅层优先、封顶 60 行、含文档密度', () => {
    const tree = [
      {
        path: 'docs/',
        name: 'docs',
        depth: 1,
        mdCount: 94,
        totalFiles: 100,
        children: [
          { path: 'docs/features/', name: 'features', depth: 2, mdCount: 30, totalFiles: 30, children: [] },
        ],
      },
      {
        path: 'sdk/',
        name: 'sdk',
        depth: 1,
        mdCount: 2,
        totalFiles: 60,
        children: [],
      },
    ];
    const evidence = buildDirEvidence(tree);
    const lines = evidence.split('\n');
    expect(lines).toHaveLength(3);
    // 浅层优先（depth 1 先于 2），同层文件数多者优先
    expect(lines[0]).toContain('docs/ | 94/100 docs | depth 1');
    expect(lines[1]).toContain('sdk/ | 2/60 docs | depth 1');
    expect(lines[2]).toContain('docs/features/ | 30/30 docs | depth 2');
  });
});
