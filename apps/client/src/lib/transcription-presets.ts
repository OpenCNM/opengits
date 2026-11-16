import { z } from 'zod';
import { sanitizePromptText } from './prompt-safety';
import { renderPresetDirective } from './prompt-presets';

import type { TeachingDepth } from './llm-gateway/registry';

/**
 * 转录预设注册表（集中管理，反硬编码红线：新增风格只改本文件，禁止散落 if/else）。
 *
 * 预设 = 注入 LLM 写作 prompt 的风格指令 + 可选的既有旋钮默认值；与用户自由指令
 * （customPrompt）经 buildStyleDirective 合并为单段风格文本，由 document-processor
 * 注入两个写作点：代码章节（buildPedagogyPrompt）与文档增强（enhanceMarkdown）。
 * 翻译环节维持既有 customPrompt 注入不变。
 *
 * 本模块必须保持客户端可用（ImportWizard 直接引用）：零服务端依赖，仅 zod + 纯函数。
 */

export interface TranscriptionPreset {
  id: string;
  /** UI 展示名 */
  name: string;
  /** UI 展示的一句话说明（title 提示） */
  description: string;
  /** 注入写作 prompt 的风格指令（面向模型的写作要求，非用户文案） */
  directive: string;
  /** lucide 图标名（讲法 chips/抽屉/切换器集中映射渲染，注册表保持数据纯度） */
  icon: 'graduation-cap' | 'microscope' | 'list-checks' | 'book-marked' | 'arrow-left-right' | 'layers';
  /** chips 选中/标识的主题色类（沿用 recommendationTiers 的 className 模式） */
  toneClass: string;
  /** 预设推荐的既有旋钮档位（仅当调用方未显式指定时生效） */
  defaults?: {
    teachingDepth?: TeachingDepth;
    aiCondensation?: string;
  };
}

export const TRANSCRIPTION_PRESETS: readonly TranscriptionPreset[] = [
  {
    id: 'standard',
    name: '教学解读',
    description: '渐进式讲解：先讲设计动机再给代码证据，标注关键设计决策',
    directive: renderPresetDirective('transcription_style_standard'),
    icon: 'graduation-cap',
    toneClass: 'text-sky-600 bg-sky-500/10 border-sky-500/30',
    defaults: { teachingDepth: 'standard', aiCondensation: 'balanced' },
  },
  {
    id: 'deep',
    name: '深度剖析',
    description: '逐函数深讲：完整签名、边界条件与设计权衡',
    directive: renderPresetDirective('transcription_style_deep'),
    icon: 'microscope',
    toneClass: 'text-violet-600 bg-violet-500/10 border-violet-500/30',
    defaults: { teachingDepth: 'deep' },
  },
  {
    id: 'cheatsheet',
    name: '速查手册',
    description: '查表优先：API 表格 + 极简要点，为快速检索优化',
    directive: renderPresetDirective('transcription_style_cheatsheet'),
    icon: 'list-checks',
    toneClass: 'text-amber-600 bg-amber-500/10 border-amber-500/30',
    defaults: { aiCondensation: 'tldr' },
  },
  {
    id: 'faithful',
    name: '忠实原文',
    description: '只修排版不改写：保留原文措辞与结构',
    directive: renderPresetDirective('transcription_style_faithful'),
    icon: 'book-marked',
    toneClass: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/30',
    defaults: { aiCondensation: 'faithful' },
  },
  {
    id: 'analogy',
    name: '类比桥接',
    description: '以你熟悉的技术为锚点对照讲解（在下方指令里写明你的技术背景）',
    directive: renderPresetDirective('transcription_style_analogy'),
    icon: 'arrow-left-right',
    toneClass: 'text-rose-600 bg-rose-500/10 border-rose-500/30',
  },
];

export const DEFAULT_TRANSCRIPTION_PRESET_ID = 'standard';

/** preset id 白名单（Schema Triad 的 Zod 层，仅 resolveTranscriptionPreset 内部消费） */
const transcriptionPresetIdSchema = z.enum(
  TRANSCRIPTION_PRESETS.map((p) => p.id) as [string, ...string[]],
);

/** 用户自由指令长度上限（token 预算与 prompt 注入面控制，仅 buildStyleDirective 消费） */
const CUSTOM_PROMPT_MAX_CHARS = 2000;

/**
 * 解析预设：未知/缺省 id 静默回落默认值（历史 repoProfile 脏数据不报错）。
 */
export function resolveTranscriptionPreset(id?: string | null): TranscriptionPreset {
  const parsed = typeof id === 'string' ? transcriptionPresetIdSchema.safeParse(id) : null;
  const key = parsed?.success ? parsed.data : DEFAULT_TRANSCRIPTION_PRESET_ID;
  return TRANSCRIPTION_PRESETS.find((p) => p.id === key) ?? TRANSCRIPTION_PRESETS[0];
}

/**
 * 合并预设指令 + 用户自定义指令为单段风格文本：
 * - 用户文本过 sanitizePromptText 清洗（prompt injection 防护）并截断到上限
 * - 两段皆空时返回 ''（调用方跳过注入，prompt 与无预设时完全一致）
 */
export function buildStyleDirective(presetId?: string | null, customPrompt?: string | null): string {
  const preset = resolveTranscriptionPreset(presetId);
  const parts: string[] = [];
  if (preset.directive) {
    parts.push(preset.directive);
  }
  const trimmed = (customPrompt || '').trim();
  if (trimmed) {
    parts.push(`USER CUSTOM INSTRUCTION: ${sanitizePromptText(trimmed.slice(0, CUSTOM_PROMPT_MAX_CHARS))}`);
  }
  return parts.join('\n');
}
