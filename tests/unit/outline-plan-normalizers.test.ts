import { describe, expect, it } from 'vitest';
import { normalizeOutlinePlan } from '@/lib/llm-gateway/normalizers';

/**
 * 专题切片归一收敛漏斗测试（Thematic Slice Normalizer Funnel Tests）：
 * - intentMode 顶层归一：合法值透传、非法/缺失清除（不默认 full_repo，Go 侧负责缺省归一）；
 * - 章级 focusFiles 池：别名 focusFiles/focus_files，数组化 + trim + 去空 + 去重 + 截 8；
 * - files 别名分流：thematic 且目标三别名缺失时 files → focusFiles（非专题保持 files → targetPaths）；
 * - README 保底条件化：仅在该章归一后 focusFiles 为空时注入；
 * - moduleTitle 中立保底：thematic 三 phase 分支合一为「核心专题剖析」，非专题原文案逐字节回归。
 * 断言直接落在 normalizeOutlinePlan 纯函数输出上（与 zod 闸门解耦，闸门契约由 registry 侧测试锚定）。
 */

/** 构造最小合法章节（moduleTitle 由归一器衍生/继承） */
const mkChapter = (overrides: Record<string, unknown> = {}) => ({
  name: '第 1 章: 状态机与协议握手',
  summary: '状态流转核心机制',
  phase: '入门',
  ...overrides,
});

describe('normalizeOutlinePlan 专题切片归一（thematic_slice）', () => {
  it('🧪 [TC-THEMATIC-FILES-DIVERT] thematic 下 files 别名进 focusFiles 池（而非 targetPaths），且不注入 README', () => {
    const raw = {
      intentMode: 'thematic_slice',
      chapters: [
        mkChapter({ files: ['src/state-machine.ts', 'src/protocol/handshake.go'] }),
      ],
    };

    const norm = normalizeOutlinePlan(raw) as any;
    expect(norm.chapters).toHaveLength(1);
    expect(norm.chapters[0].focusFiles).toEqual(['src/state-machine.ts', 'src/protocol/handshake.go']);
    expect(norm.chapters[0].targetPaths).toEqual([]);
    expect(norm.chapters[0].moduleTitle).toBe('模块 1: 核心专题剖析');
  });

  it('🧪 [TC-THEMATIC-FILES-DIVERT-MERGE] thematic 下 focusFiles 别名与 files 同时存在且无目标别名时，合并进同一 focusFiles 池', () => {
    const raw = {
      intentMode: 'thematic_slice',
      chapters: [
        mkChapter({
          focusFiles: ['src/core/engine.ts'],
          files: ['src/core/engine.ts', 'src/core/scheduler.ts'],
        }),
      ],
    };

    const norm = normalizeOutlinePlan(raw) as any;
    // 去重合并：engine.ts 只保留一份，顺序为先别名后 files
    expect(norm.chapters[0].focusFiles).toEqual(['src/core/engine.ts', 'src/core/scheduler.ts']);
    expect(norm.chapters[0].targetPaths).toEqual([]);
  });

  it('🧪 [TC-THEMATIC-README-GUARD] README 保底仅在归一后 focusFiles 为空时注入；focus 非空时 targetPaths 保持空数组', () => {
    const cases = [
      {
        name: 'focus 缺失 → README 保底照常',
        chapter: mkChapter(),
        expectTargetPaths: ['README.md'],
        expectFocusFiles: undefined,
      },
      {
        name: 'focus 非空 → targets 保持 []，不塞 README',
        chapter: mkChapter({ focusFiles: ['src/auth/login.ts'] }),
        expectTargetPaths: [],
        expectFocusFiles: ['src/auth/login.ts'],
      },
      {
        name: 'focus 全空串（归一后为空）→ README 保底照常',
        chapter: mkChapter({ focusFiles: ['   ', ''] }),
        expectTargetPaths: ['README.md'],
        expectFocusFiles: undefined,
      },
    ];

    for (const t of cases) {
      const norm = normalizeOutlinePlan({
        intentMode: 'thematic_slice',
        chapters: [t.chapter],
      }) as any;
      expect(norm.chapters[0].targetPaths, t.name).toEqual(t.expectTargetPaths);
      expect(norm.chapters[0].focusFiles, t.name).toEqual(t.expectFocusFiles);
    }
  });

  it('🧪 [TC-THEMATIC-TARGETS-ALIAS-WIN] thematic 下 targetPaths/paths/target_paths 任一存在时，files 保持旧语义不进 focusFiles 池', () => {
    const cases = [
      { name: 'targetPaths 别名', chapter: mkChapter({ targetPaths: ['src/a.ts'], files: ['src/b.ts'] }) },
      { name: 'paths 别名', chapter: mkChapter({ paths: ['src/a.ts'], files: ['src/b.ts'] }) },
      { name: 'target_paths 蛇形别名', chapter: mkChapter({ target_paths: ['src/a.ts'], files: ['src/b.ts'] }) },
    ];

    for (const t of cases) {
      const norm = normalizeOutlinePlan({
        intentMode: 'thematic_slice',
        chapters: [t.chapter],
      }) as any;
      // 目标别名优先解析为 targetPaths；files 被忽略（与既有 ?? 链语义一致）
      expect(norm.chapters[0].targetPaths, t.name).toEqual(['src/a.ts']);
      expect(norm.chapters[0].focusFiles, t.name).toBeUndefined();
    }
  });

  it.each([
    ['入门', '模块 1: 核心专题剖析'],
    ['进阶', '模块 1: 核心专题剖析'],
    ['实战', '模块 1: 核心专题剖析'],
  ])('🧪 [TC-THEMATIC-MODULETITLE-NEUTRAL] thematic 下缺失 moduleTitle 时三 phase 分支合一为中立专题文案（phase=%s）', (phase, expected) => {
    const norm = normalizeOutlinePlan({
      intentMode: 'thematic_slice',
      chapters: [mkChapter({ phase })],
    }) as any;
    expect(norm.chapters[0].moduleTitle).toBe(expected);
  });
});

describe('normalizeOutlinePlan 默认路径回归（full_repo / intentMode 缺失，逐字节不变）', () => {
  it.each([
    ['入门', '模块 1: 架构全景与环境准备'],
    ['进阶', '模块 1: 核心引擎与关键机制'],
    ['实战', '模块 1: 综合实战与扩展应用'],
  ])('🧪 [TC-DEFAULT-MODULETITLE-REGRESSION] 非 thematic 缺失 moduleTitle 时保留原 phase 衍生文案（phase=%s）', (phase, expected) => {
    for (const intentMode of [undefined, 'full_repo']) {
      const raw: Record<string, unknown> = { chapters: [mkChapter({ phase })] };
      if (intentMode !== undefined) raw.intentMode = intentMode;
      const norm = normalizeOutlinePlan(raw) as any;
      expect(norm.chapters[0].moduleTitle, String(intentMode)).toBe(expected);
    }
  });

  it('🧪 [TC-DEFAULT-FILES-PATH-REGRESSION] 非 thematic 下 files → targetPaths 现行为逐字节不变（含截 4 与 README 保底）', () => {
    const norm = normalizeOutlinePlan({
      chapters: [
        mkChapter({ files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] }),
        mkChapter({ name: '第 2 章: 无任何目标', files: [] }),
      ],
    }) as any;
    expect(norm.chapters[0].targetPaths).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    expect(norm.chapters[0].focusFiles).toBeUndefined();
    expect(norm.chapters[1].targetPaths).toEqual(['README.md']);
    expect(norm.chapters[1].focusFiles).toBeUndefined();
  });
});

describe('normalizeOutlinePlan intentMode 顶层归一', () => {
  it.each([
    ['thematic', '非法字符串'],
    ['', '空串'],
    ['  thematic_slice  ', '带空白但合法 → trim 后透传'],
    [123, '数字'],
    [null, 'null'],
    [undefined, '缺失'],
    [{ mode: 'thematic_slice' }, '对象'],
  ])('🧪 [TC-INTENT-MODE-NORMALIZE] intentMode=%p（%s）不阻断归一，非法值清除为 undefined', (intentMode, label) => {
    const norm = normalizeOutlinePlan({
      intentMode,
      chapters: [mkChapter({ targetPaths: ['src/a.ts'] })],
    }) as any;
    const expected =
      typeof intentMode === 'string' && intentMode.trim() === 'thematic_slice' ? 'thematic_slice' : undefined;
    expect(norm.intentMode, label).toBe(expected);
    // 不阻断：章节自愈照常完成，且 moduleTitle 衍生随意图模式分流
    expect(norm.chapters[0].moduleTitle, label).toBe(
      expected === 'thematic_slice' ? '模块 1: 核心专题剖析' : '模块 1: 架构全景与环境准备',
    );
    expect(norm.chapters[0].name).toBe('第 1 章: 状态机与协议握手');
    expect(norm.chapters[0].targetPaths).toEqual(['src/a.ts']);
  });

  it('🧪 [TC-INTENT-MODE-ENVELOPE] intentMode 位于信封内层（data.curriculum）时随解包透传生效', () => {
    const norm = normalizeOutlinePlan({
      data: {
        intentMode: 'thematic_slice',
        chapters: [mkChapter({ files: ['src/x.ts'] })],
      },
    }) as any;
    expect(norm.intentMode).toBe('thematic_slice');
    expect(norm.chapters[0].focusFiles).toEqual(['src/x.ts']);
    expect(norm.chapters[0].targetPaths).toEqual([]);
  });
});

describe('normalizeOutlinePlan focusFiles 池收敛', () => {
  it('🧪 [TC-FOCUS-CAP-8] focusFiles 逐项 trim、去空、去重、截 8（9 项含重复 → 8 项唯一）', () => {
    const focusFiles = [
      '  src/a.ts  ',
      'src/a.ts', // 与 trim 后的重复
      '',
      '   ',
      42 as unknown as string, // 非字符串项 → 丢弃
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
      'src/e.ts',
      'src/f.ts',
      'src/g.ts',
      'src/h.ts',
      'src/i.ts', // 第 9 个有效项 → 截断
    ];
    const norm = normalizeOutlinePlan({
      intentMode: 'thematic_slice',
      chapters: [mkChapter({ focusFiles })],
    }) as any;
    expect(norm.chapters[0].focusFiles).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
      'src/e.ts',
      'src/f.ts',
      'src/g.ts',
      'src/h.ts',
    ]);
  });

  it('🧪 [TC-FOCUS-SNAKE-ALIAS] focus_files 蛇形别名与驼峰别名等价', () => {
    for (const key of ['focusFiles', 'focus_files']) {
      const norm = normalizeOutlinePlan({
        intentMode: 'thematic_slice',
        chapters: [mkChapter({ [key]: ['src/only.ts'] })],
      }) as any;
      expect(norm.chapters[0].focusFiles, key).toEqual(['src/only.ts']);
    }
  });

  it('🧪 [TC-FOCUS-SINGLE-STRING] focusFiles 单字符串自动数组化', () => {
    const norm = normalizeOutlinePlan({
      intentMode: 'thematic_slice',
      chapters: [mkChapter({ focusFiles: 'src/single.ts' })],
    }) as any;
    expect(norm.chapters[0].focusFiles).toEqual(['src/single.ts']);
  });
});
