/**
 * 「换个思路」编排栏的配置中枢（纯 TS，无 JSX）：
 * - 4 个主导方向的动机配置（getReorganizeMotives，语义与历史版本一致）；
 * - 3 个次级分类（clarify/compact/expand）× 预设子选项矩阵（getReorganizeCategories）；
 * - 基于当前大纲的动态章节子选项构建（buildChapterSubOptions，纯确定性投影，零 LLM）。
 * 全部 UI 文案经 paraglide m.* 下发，严禁散落硬编码文本。
 */

import {
  REORGANIZE_ARCHETYPE_IDS,
  REORGANIZE_CATEGORY_IDS,
  REORGANIZE_CHAPTER_OPTIONS_MAX,
  REORGANIZE_PACING_IDS,
  type ReorganizeCategoryId,
  type ReorganizeLearnerArchetype,
  type ReorganizePacing,
} from '@/lib/constants';
import * as m from '@/paraglide/messages';
import type { WorkbenchOutlineCategory } from './editor/OutlineCategoryBlock';

/** 章节子选项 payload 摘录的关联文件上限（防 prompt 膨胀，取前三条代表文件） */
const CHAPTER_PROMPT_FILES_MAX = 3;

/** 档位全量枚举冻结镜像（编译期守卫：constants 侧枚举漂移时立即编译失败，倒逼同步排查） */
export const REORGANIZE_PACING_FREEZE = [
  'compact',
  'normal',
  'detailed',
] as const satisfies typeof REORGANIZE_PACING_IDS;

/** 学习者画像全量枚举冻结镜像（同上，防本模块散落的画像字面量与 constants 失配） */
export const REORGANIZE_ARCHETYPE_FREEZE = [
  'architecture_overview',
  'deep_dive_internals',
  'cross_language_migrant',
  'pedagogical_beginner',
] as const satisfies typeof REORGANIZE_ARCHETYPE_IDS;

/** 学习者画像（兼容别名：沿用 constants 全量枚举，与 llm-gateway LEARNER_ARCHETYPE_FOCUS 查表键对齐） */
export type LearnerArchetype = ReorganizeLearnerArchetype;

/** 「换个思路」主导方向四值枚举（重摇 / 梳理 / 收敛 / 深化） */
export type ReorganizeMotive = 'reroll' | 'untangle' | 'compact' | 'detailed';

/** 主导方向的动机配置（icon 为 emoji 视觉锚，label/sub/basePrompt 经 paraglide 下发） */
interface MotiveConfig {
  id: ReorganizeMotive;
  icon: string;
  label: string;
  sub: string;
  pacing: ReorganizePacing;
  learnerArchetype: LearnerArchetype;
  basePrompt: string;
}

/** 下发重排引擎的高密度执行参数（prompt + 全局档位 + 学习者画像） */
export interface ReorganizeOptions {
  customPrompt: string;
  pacing: ReorganizePacing;
  learnerArchetype?: LearnerArchetype;
}

/** 次级子选项来源类型：预设矩阵 / 动态章节 / 用户自定义 */
export type ReorganizeSubOptionKind = 'preset' | 'chapter' | 'custom';

/** 次级子选项（Popover 菜单条目：短标签 + 悬浮说明 + 下发参数） */
export interface ReorganizeSubOption {
  id: string;
  /** paraglide 短标签（6~12 字，一行收纳） */
  label: string;
  /** 悬浮说明 */
  hint?: string;
  kind: ReorganizeSubOptionKind;
  /** 实际下发引擎的高密度执行参数 */
  payload: ReorganizeOptions;
}

/** 次级分类（底部栏的 3 个方向按钮，每个对应一个 Popover） */
export interface ReorganizeCategory {
  id: ReorganizeCategoryId;
  label: string;
  sub: string;
  options: ReorganizeSubOption[];
}

/** 4 个主导方向的动机配置（随 locale 即时求值，语义与历史版本保持一致） */
export function getReorganizeMotives(): MotiveConfig[] {
  return [
    {
      id: 'reroll',
      icon: '🎲',
      label: m.workbench_reorganize_fresh_label(),
      sub: m.workbench_reorganize_fresh_sub(),
      pacing: 'normal',
      learnerArchetype: 'architecture_overview',
      basePrompt: m.workbench_reorganize_fresh_prompt(),
    },
    {
      id: 'untangle',
      icon: '🧹',
      label: m.workbench_reorganize_clarify_label(),
      sub: m.workbench_reorganize_clarify_sub(),
      pacing: 'normal',
      learnerArchetype: 'architecture_overview',
      basePrompt: m.workbench_reorganize_clarify_prompt(),
    },
    {
      id: 'compact',
      icon: '⚡',
      label: m.workbench_reorganize_fewer_label(),
      sub: m.workbench_reorganize_fewer_sub(),
      pacing: 'compact',
      learnerArchetype: 'architecture_overview',
      basePrompt: m.workbench_reorganize_fewer_prompt(),
    },
    {
      id: 'detailed',
      icon: '🔍',
      label: m.workbench_reorganize_more_label(),
      sub: m.workbench_reorganize_more_sub(),
      pacing: 'detailed',
      learnerArchetype: 'deep_dive_internals',
      basePrompt: m.workbench_reorganize_more_prompt(),
    },
  ];
}

/**
 * 「换个思路」三分类预设矩阵（每次调用即时求值，跟随 paraglide locale 切换）：
 * clarify 梳理脉络（锁定 normal）/ compact 收敛篇幅（锁定 compact）/ expand 展开细节（锁定 detailed）。
 * Record 键控保证三分类全覆盖零遗漏，数组序与 REORGANIZE_CATEGORY_IDS 对齐。
 */
export function getReorganizeCategories(): ReorganizeCategory[] {
  const matrix: Record<
    ReorganizeCategoryId,
    { label: string; sub: string; options: ReorganizeSubOption[] }
  > = {
    clarify: {
      label: m.workbench_reorganize_clarify_label(),
      sub: m.workbench_reorganize_clarify_sub(),
      options: [
        {
          id: 'by_call_chain',
          label: m.workbench_reorganize_opt_by_call_chain(),
          hint: m.workbench_reorganize_opt_by_call_chain_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_by_call_chain_prompt(),
            pacing: 'normal',
            learnerArchetype: 'deep_dive_internals',
          },
        },
        {
          id: 'by_layers',
          label: m.workbench_reorganize_opt_by_layers(),
          hint: m.workbench_reorganize_opt_by_layers_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_by_layers_prompt(),
            pacing: 'normal',
            learnerArchetype: 'architecture_overview',
          },
        },
        {
          id: 'by_module',
          label: m.workbench_reorganize_opt_by_module(),
          hint: m.workbench_reorganize_opt_by_module_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_by_module_prompt(),
            pacing: 'normal',
            learnerArchetype: 'architecture_overview',
          },
        },
      ],
    },
    compact: {
      label: m.workbench_reorganize_fewer_label(),
      sub: m.workbench_reorganize_fewer_sub(),
      options: [
        {
          id: 'minimal_backbone',
          label: m.workbench_reorganize_opt_minimal_backbone(),
          hint: m.workbench_reorganize_opt_minimal_backbone_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_minimal_backbone_prompt(),
            pacing: 'compact',
            learnerArchetype: 'architecture_overview',
          },
        },
        {
          id: 'standard_refine',
          label: m.workbench_reorganize_opt_standard_refine(),
          hint: m.workbench_reorganize_opt_standard_refine_sub(),
          kind: 'preset',
          // prompt 复用 fewer_prompt（与主导「收敛」语义完全对齐，不另造文案键）
          payload: {
            customPrompt: m.workbench_reorganize_fewer_prompt(),
            pacing: 'compact',
            learnerArchetype: 'architecture_overview',
          },
        },
        {
          id: 'skip_basics',
          label: m.workbench_reorganize_opt_skip_basics(),
          hint: m.workbench_reorganize_opt_skip_basics_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_skip_basics_prompt(),
            pacing: 'compact',
            learnerArchetype: 'cross_language_migrant',
          },
        },
      ],
    },
    expand: {
      label: m.workbench_reorganize_more_label(),
      sub: m.workbench_reorganize_more_sub(),
      options: [
        {
          id: 'deep_source',
          label: m.workbench_reorganize_opt_deep_source(),
          hint: m.workbench_reorganize_opt_deep_source_sub(),
          kind: 'preset',
          // prompt 复用 more_prompt（与主导「深化」语义完全对齐，不另造文案键）
          payload: {
            customPrompt: m.workbench_reorganize_more_prompt(),
            pacing: 'detailed',
            learnerArchetype: 'deep_dive_internals',
          },
        },
        {
          id: 'patterns_boundaries',
          label: m.workbench_reorganize_opt_patterns_boundaries(),
          hint: m.workbench_reorganize_opt_patterns_boundaries_sub(),
          kind: 'preset',
          payload: {
            customPrompt: m.workbench_reorganize_opt_patterns_boundaries_prompt(),
            pacing: 'detailed',
            learnerArchetype: 'deep_dive_internals',
          },
        },
      ],
    },
  };

  return REORGANIZE_CATEGORY_IDS.map((id) => ({ id, ...matrix[id] }));
}

/**
 * 基于当前大纲构建「展开细节」的动态章节子选项（纯确定性投影，零 LLM）：
 * 标题取 `title || name` 原文（空标题跳过，防空串漂移）；按关联文件数降序取前
 * REORGANIZE_CHAPTER_OPTIONS_MAX 条（并列保持原序，稳定可复现）。
 * payload.pacing 锁定 normal——档位是带硬性章节数语义的全局旋钮
 * （compact 5-7 / normal 8-10 / detailed 11-14），差异化深化由锚定指令承载，
 * 不动全局档位；learnerArchetype 锚定 deep_dive_internals。
 */
export function buildChapterSubOptions(
  outline: WorkbenchOutlineCategory[],
): ReorganizeSubOption[] {
  const ranked = outline
    .map((cat, index) => ({
      cat,
      index,
      title: (cat.title || cat.name || '').trim(),
      fileCount: cat.files?.length ?? 0,
    }))
    .filter((entry) => entry.title.length > 0)
    .sort((a, b) => b.fileCount - a.fileCount || a.index - b.index)
    .slice(0, REORGANIZE_CHAPTER_OPTIONS_MAX);

  return ranked.map((entry, rankIndex) => {
    const { cat, title } = entry;
    const files = (cat.files ?? [])
      .map((file) => file.path || file.shortTitle || '')
      .filter(Boolean)
      .slice(0, CHAPTER_PROMPT_FILES_MAX)
      .join(', ');

    const option: ReorganizeSubOption = {
      id: `chapter-${rankIndex}`,
      // 章节标题原样透传（展示侧负责钳制宽度，此处不做截断）
      label: title,
      kind: 'chapter',
      payload: {
        customPrompt: files
          ? m.workbench_reorganize_opt_chapter_prompt({ title, files })
          : m.workbench_reorganize_opt_chapter_prompt_nofiles({ title }),
        pacing: 'normal',
        learnerArchetype: 'deep_dive_internals',
      },
    };
    return option;
  });
}
