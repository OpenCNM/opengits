import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';
import { ALL_PROMPT_PRESETS } from './prompt-presets';

// ---------- 1. Zod Validation Schemas (Layer 2 Sync) ----------

export const ModelConfigSchema = z.object({
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  responseFormat: z.string().optional(),
  modelName: z.string().optional(),
});

export const PromptSchemaObject = z.object({
  role: z.string(),
  taskDescription: z.string(),
  rules: z.array(z.string()).default([]),
  outputSchemaHint: z.record(z.string(), z.any()).optional(),
  language: z.string().default('zh-CN'),
});

export const SystemPromptPayloadSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  module: z.string().min(1),
  modelConfig: ModelConfigSchema.optional(),
  promptSchema: PromptSchemaObject,
});

// ---------- 2. TypeScript Interfaces (Layer 3 Sync) ----------

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type PromptSchemaDefinition = z.infer<typeof PromptSchemaObject>;
export type SystemPromptPayload = z.infer<typeof SystemPromptPayloadSchema>;

export interface CompiledPromptResult {
  key: string;
  version: number;
  compiledPrompt: string;
  modelConfig?: ModelConfig;
  language: string;
}

export interface PromptDriftRow {
  key: string;
  state: 'MISSING' | 'DRIFTED' | 'OK';
  dbVersion: number | null;
}

export interface PromptDriftReport {
  rows: PromptDriftRow[];
  orphanKeys: string[];
}

function canonicalize(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

// 内存 10 分钟缓存结构
interface CacheEntry {
  ts: number;
  data: {
    version: number;
    promptSchema: PromptSchemaDefinition;
    modelConfig?: ModelConfig;
  };
}

const MEMORY_CACHE_TTL_MS = 10 * 60 * 1000;
const memoryCache = new Map<string, CacheEntry>();

/**
 * 各预设 key 的缺省变量兜底：调用方未显式传入时注入默认值，
 * 杜绝未替换的 {{var}} 字面量残留在编译文本中（getCompiledPrompt / mergeDefaultVars 共用）。
 */
const DEFAULT_KEY_VARS: Record<string, Record<string, string>> = {
  outline_prompt_expand: { categoryIntent: 'general' },
};

/**
 * 统一 Prompt 注册服务中心 (PromptRegistry)
 * - 结合 Postgres (Prisma) 持久化 + 10 分钟内存缓存 + 代码零闪断兜底
 */
export class PromptRegistry {
  /**
   * 编译指定 Prompt 模版，注入动态变量（如 {{targetLanguage}}, {{owner}}, {{repo}}）
   */
  static async getCompiledPrompt(
    key: string,
    variables: Record<string, any> = {},
    fallbackSchema?: PromptSchemaDefinition,
    fallbackConfig?: ModelConfig
  ): Promise<CompiledPromptResult> {
    const cached = memoryCache.get(key);
    let version = 1;
    let schema: PromptSchemaDefinition;
    let modelConfig: ModelConfig | undefined = fallbackConfig;

    if (cached && Date.now() - cached.ts < MEMORY_CACHE_TTL_MS) {
      version = cached.data.version;
      schema = cached.data.promptSchema;
      modelConfig = cached.data.modelConfig || fallbackConfig;
    } else {
      try {
        const sysPrompt = await prisma.systemPrompt.findUnique({
          where: { key },
          include: {
            versions: {
              where: { isDefault: true },
              orderBy: { version: 'desc' },
              take: 1,
            },
          },
        });

        if (sysPrompt && sysPrompt.versions.length > 0) {
          const ver = sysPrompt.versions[0];
          version = ver.version;
          schema = ver.promptSchema as unknown as PromptSchemaDefinition;
          modelConfig = (ver.modelConfig as unknown as ModelConfig) || fallbackConfig;

          memoryCache.set(key, {
            ts: Date.now(),
            data: { version, promptSchema: schema, modelConfig },
          });
        } else {
          schema = fallbackSchema || this.getDefaultFallbackSchema(key);
        }
      } catch (err) {
        console.warn(`[PromptRegistry] Database read failed for key "${key}", using fallback`, err);
        schema = fallbackSchema || this.getDefaultFallbackSchema(key);
      }
    }

    const targetLang = variables.targetLanguage || schema.language || 'zh-CN';
    const isZh = !targetLang || targetLang === 'zh-CN' || targetLang === 'zh' || targetLang === 'none';

    const mergedVars = {
      targetLanguage: targetLang,
      categoryNameSample: isZh ? '第一模块 · 核心原理与组件结构' : `Module 1 · Core Concepts`,
      shortTitleSample: isZh ? '架构引言' : `Architecture Overview`,
      ...(DEFAULT_KEY_VARS[key] ?? {}),
      ...variables,
    };

    const compiledPrompt = this.renderPromptText(schema, mergedVars);

    return {
      key,
      version,
      compiledPrompt,
      modelConfig,
      language: schema.language || 'zh-CN',
    };
  }

  /**
   * 同步编译预设（专为不可异步化的 Fallback / 初始化路径设计）
   */
  public static compilePresetSync(key: string, variables: Record<string, any> = {}): string {
    const schema = this.getDefaultFallbackSchema(key);
    return this.renderPromptText(schema, this.mergeDefaultVars(schema, variables, key));
  }

  /**
   * 合并默认模板变量（getCompiledPrompt / compilePresetSync / compileFromCacheSync 共用）。
   */
  private static mergeDefaultVars(schema: PromptSchemaDefinition, variables: Record<string, any>, key?: string): Record<string, any> {
    const targetLang = variables.targetLanguage || schema.language || 'zh-CN';
    const isZh = !targetLang || targetLang === 'zh-CN' || targetLang === 'zh' || targetLang === 'none';
    return {
      targetLanguage: targetLang,
      categoryNameSample: isZh ? '第一模块 · 核心原理与组件结构' : `Module 1 · Core Concepts`,
      shortTitleSample: isZh ? '架构引言' : `Architecture Overview`,
      navBlocksText: '(None)',
      ...(key ? (DEFAULT_KEY_VARS[key] ?? {}) : {}),
      ...variables,
    };
  }

  /**
   * 同步渲染 DB 托管版本（读 getCompiledPrompt 已填充的内存缓存，无 DB 开销）。
   * 未命中返回 null（调用方回退代码预设）。供同步热路径（如 tutor 首 token）
   * 消费 admin 热编辑成果——admin revalidate 通知清缓存后自然回到代码预设并后台重热。
   */
  public static compileFromCacheSync(key: string, variables: Record<string, any> = {}): string | null {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    return this.renderPromptText(entry.data.promptSchema, this.mergeDefaultVars(entry.data.promptSchema, variables, key));
  }

  /**
   * 将组件构造成标准系统提示词字符串
   */
  public static renderPromptText(schema: PromptSchemaDefinition, variables: Record<string, any>): string {
    let text = `${schema.role}\n\n${schema.taskDescription}`;

    if (schema.rules && schema.rules.length > 0) {
      text += `\n\nCORE RULES & CONSTRAINTS:\n` + schema.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
    }

    if (schema.outputSchemaHint) {
      text += `\n\nRespond strictly with a JSON object matching this schema:\n` + JSON.stringify(schema.outputSchemaHint, null, 2);
    }

    // 简单高效变量替换 {{varName}}；用函数替换避免 vVal 中的 `$&`/`$1` 等被替换引擎误解释
    for (const [vKey, vVal] of Object.entries(variables)) {
      const placeholder = new RegExp(`{{\\s*${vKey}\\s*}}`, 'g');
      text = text.replace(placeholder, () => String(vVal ?? ''));
    }

    return text;
  }

  /**
   * 在数据库中保存/更新 Prompt 版本并刷新缓存
   *
   * 原子事务：读当前版本 → 原子递增 currentVer → 取消旧默认 → 写入新版本，
   * 任一步失败全量 ROLLBACK（杜绝"旧默认已取消但新版本未落库"的零默认脏状态）。
   */
  static async savePromptVersion(payload: SystemPromptPayload): Promise<{ key: string; version: number }> {
    const validated = SystemPromptPayloadSchema.parse(payload);
    const { key, name, module: modKey, modelConfig, promptSchema } = validated;

    const { newVersionNumber } = await prisma.$transaction(async (tx) => {
      const existing = await tx.systemPrompt.findUnique({
        where: { key },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });

      if (existing) {
        // 原子递增 currentVer：并发保存时每次各得唯一版本号（不重号、不回退）
        const updated = await tx.systemPrompt.update({
          where: { id: existing.id },
          data: { currentVer: { increment: 1 }, updatedAt: new Date() },
        });

        // 取消旧默认标志
        await tx.promptVersion.updateMany({
          where: { promptId: existing.id },
          data: { isDefault: false },
        });

        // Prisma Json 字段无对应字面量类型，经 unknown 定向收窄（语义不变）
        await tx.promptVersion.create({
          data: {
            promptId: existing.id,
            version: updated.currentVer,
            promptSchema: promptSchema as unknown as Prisma.InputJsonValue,
            modelConfig: modelConfig as unknown as Prisma.InputJsonValue | undefined,
            isDefault: true,
          },
        });

        return { newVersionNumber: updated.currentVer };
      }

      const created = await tx.systemPrompt.create({
        data: {
          key,
          name,
          module: modKey,
          currentVer: 1,
        },
      });

      await tx.promptVersion.create({
        data: {
          promptId: created.id,
          version: 1,
          promptSchema: promptSchema as unknown as Prisma.InputJsonValue,
          modelConfig: modelConfig as unknown as Prisma.InputJsonValue | undefined,
          isDefault: true,
        },
      });

      return { newVersionNumber: 1 };
    });

    // 清除/更新内存缓存
    memoryCache.set(key, {
      ts: Date.now(),
      data: {
        version: newVersionNumber,
        promptSchema,
        modelConfig,
      },
    });

    return { key, version: newVersionNumber };
  }

  /**
   * 清除特定 Prompt 的内存缓存
   */
  static invalidateCache(key?: string) {
    if (key) {
      memoryCache.delete(key);
    } else {
      memoryCache.clear();
    }
  }

  /**
   * 读取指定 key 当前缓存中的编译版本号（getCompiledPrompt 的零成本伴生读取：
   * 同一请求内 compile 刚填充过缓存；未命中/未托管返回 undefined）。
   * 供网关生成记账做"prompt 版本 ↔ 质量"回溯（eval 捕获侧）。
   */
  public static getCompiledVersion(key: string): number | undefined {
    return memoryCache.get(key)?.data.version;
  }

  /**
   * 种子初始化（2026-11 SSOT 语义反转）：仅为数据库中无默认版本的预设入库 v1，
   * 已有版本一律不触碰——数据库是运行时事实源（热编辑目标），代码预设只是种子与兜底。
   * admin 后台与 prisma/seed.ts 共用本单一实现。
   */
  static async seedMissingPresets(): Promise<{ createdKeys: string[] }> {
    const createdKeys: string[] = [];
    for (const preset of ALL_PROMPT_PRESETS) {
      const existing = await prisma.systemPrompt.findUnique({
        where: { key: preset.key },
        include: {
          versions: { where: { isDefault: true }, orderBy: { version: 'desc' }, take: 1 },
        },
      });
      if (!existing || existing.versions.length === 0) {
        await PromptRegistry.savePromptVersion(preset);
        createdKeys.push(preset.key);
      }
    }
    return { createdKeys };
  }

  /**
   * 内置缺省系统提示词基线（优先取自 ALL_PROMPT_PRESETS 保证未落库或断网时 100% 结构一致）
   */
  public static getDefaultFallbackSchema(key: string): PromptSchemaDefinition {
    const preset = ALL_PROMPT_PRESETS.find((p) => p.key === key);
    if (preset) {
      return preset.promptSchema;
    }
    return {
      role: 'You are an AI assistant specialized in documentation and code analysis.',
      taskDescription: `Process the task for key ${key} accurately.`,
      rules: ['Always prioritize clarity and precision.'],
      language: 'zh-CN',
      outputSchemaHint: {
        language: 'zh-CN',
        status: 'success',
      },
    };
  }

  /**
   * 比对代码预设与数据库默认版本，产出漂移分类（只读，不写库）。
   */
  static async collectDrift(): Promise<PromptDriftRow[]> {
    const rows: PromptDriftRow[] = [];
    for (const preset of ALL_PROMPT_PRESETS) {
      const existing = await prisma.systemPrompt.findUnique({
        where: { key: preset.key },
        include: {
          versions: { where: { isDefault: true }, orderBy: { version: 'desc' }, take: 1 },
        },
      });

      if (!existing || existing.versions.length === 0) {
        rows.push({ key: preset.key, state: 'MISSING', dbVersion: null });
        continue;
      }

      const currentVer = existing.versions[0];
      const dbSchemaStr = JSON.stringify(canonicalize(currentVer.promptSchema));
      const codeSchemaStr = JSON.stringify(canonicalize(preset.promptSchema));
      const dbModelConfigStr = JSON.stringify(canonicalize(currentVer.modelConfig));
      const codeModelConfigStr = JSON.stringify(canonicalize(preset.modelConfig));

      rows.push({
        key: preset.key,
        state: dbSchemaStr !== codeSchemaStr || dbModelConfigStr !== codeModelConfigStr ? 'DRIFTED' : 'OK',
        dbVersion: currentVer.version,
      });
    }
    return rows;
  }

  /**
   * 收集预设漂移报告与孤儿 key 列表。
   */
  static async checkDrift(): Promise<PromptDriftReport> {
    const rows = await this.collectDrift();
    const dbKeys = await prisma.systemPrompt.findMany({ select: { key: true } });
    const presetKeys = new Set(ALL_PROMPT_PRESETS.map((p) => p.key));
    const orphanKeys = dbKeys.map((k) => k.key).filter((k) => !presetKeys.has(k));
    return { rows, orphanKeys };
  }

  /**
   * 打印格式化漂移检测报告。
   */
  static printDriftReport(report: PromptDriftReport): void {
    const { rows, orphanKeys } = report;
    const missing = rows.filter((r) => r.state === 'MISSING');
    const drifted = rows.filter((r) => r.state === 'DRIFTED');
    const ok = rows.filter((r) => r.state === 'OK');

    for (const r of missing) console.log(`[MISSING] ${r.key} — 代码预设未入库，运行时走代码兜底（可运行种子模式初始化）`);
    for (const r of drifted) console.log(`[DRIFTED] ${r.key} — DB v${r.dbVersion} 与代码基线不一致（后台热编辑？或代码改动未 --push）`);
    for (const k of orphanKeys) console.log(`[ORPHAN]  ${k} — DB 存在但代码无此预设（残留或已下线 key）`);

    console.log(`\n[PromptCheck] ${ALL_PROMPT_PRESETS.length} 个代码预设: ${ok.length} 一致, ${drifted.length} 漂移, ${missing.length} 缺失; ${orphanKeys.length} 个孤儿 key。`);
    if (drifted.length > 0 || missing.length > 0) {
      console.log('[PromptCheck] 漂移为警告级（运行时始终有代码兜底，不阻断）。');
    }
  }

  /**
   * CLI 门禁入口：只读漂移报告，数据库不可达时优雅跳过。
   */
  static async checkDriftCli(): Promise<void> {
    console.log(`[PromptCheck] 只读检查 ${ALL_PROMPT_PRESETS.length} 个代码预设与数据库默认版本的对齐情况...\n`);
    try {
      const report = await this.checkDrift();
      this.printDriftReport(report);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/P1001|Can't reach database|ECONNREFUSED|ETIMEDOUT|does not exist|authentication|DATABASE_URL/i.test(msg)) {
        console.log('[PromptCheck] [SKIP] 数据库不可达或未配置，跳过漂移检查（运行时始终有代码兜底，无能力损失）。');
      } else {
        throw err;
      }
    } finally {
      await prisma.$disconnect();
    }
  }
}
