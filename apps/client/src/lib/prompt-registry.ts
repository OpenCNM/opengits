import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';
import { ALL_PROMPT_PRESETS } from './prompt-presets';

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

// Prevent unreplaced {{var}} tokens when callers omit optional variables.
const DEFAULT_KEY_VARS: Record<string, Record<string, string>> = {
  outline_prompt_expand: { categoryIntent: 'general' },
};

export class PromptRegistry {
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

  public static compilePresetSync(key: string, variables: Record<string, any> = {}): string {
    const schema = this.getDefaultFallbackSchema(key);
    return this.renderPromptText(schema, this.mergeDefaultVars(schema, variables, key));
  }

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

  public static compileFromCacheSync(key: string, variables: Record<string, any> = {}): string | null {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    return this.renderPromptText(entry.data.promptSchema, this.mergeDefaultVars(entry.data.promptSchema, variables, key));
  }

  public static renderPromptText(schema: PromptSchemaDefinition, variables: Record<string, any>): string {
    let text = `${schema.role}\n\n${schema.taskDescription}`;

    if (schema.rules && schema.rules.length > 0) {
      text += `\n\nCORE RULES & CONSTRAINTS:\n` + schema.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
    }

    if (schema.outputSchemaHint) {
      text += `\n\nRespond strictly with a JSON object matching this schema:\n` + JSON.stringify(schema.outputSchemaHint, null, 2);
    }

    // Callback replacer prevents `$&` / `$1` sequences in variable values from corrupting substitutions.
    for (const [vKey, vVal] of Object.entries(variables)) {
      const placeholder = new RegExp(`{{\\s*${vKey}\\s*}}`, 'g');
      text = text.replace(placeholder, () => String(vVal ?? ''));
    }

    return text;
  }

  static async savePromptVersion(payload: SystemPromptPayload): Promise<{ key: string; version: number }> {
    const validated = SystemPromptPayloadSchema.parse(payload);
    const { key, name, module: modKey, modelConfig, promptSchema } = validated;

    const { newVersionNumber } = await prisma.$transaction(async (tx) => {
      const existing = await tx.systemPrompt.findUnique({
        where: { key },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });

      if (existing) {
        // Atomic increment guarantees monotonic unique versions under concurrent saves.
        const updated = await tx.systemPrompt.update({
          where: { id: existing.id },
          data: { currentVer: { increment: 1 }, updatedAt: new Date() },
        });

        await tx.promptVersion.updateMany({
          where: { promptId: existing.id },
          data: { isDefault: false },
        });

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

  static invalidateCache(key?: string) {
    if (key) {
      memoryCache.delete(key);
    } else {
      memoryCache.clear();
    }
  }

  public static getCompiledVersion(key: string): number | undefined {
    return memoryCache.get(key)?.data.version;
  }

  // DB is runtime SSOT; only seed missing defaults and never overwrite existing DB versions.
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

  static async checkDrift(): Promise<PromptDriftReport> {
    const rows = await this.collectDrift();
    const dbKeys = await prisma.systemPrompt.findMany({ select: { key: true } });
    const presetKeys = new Set(ALL_PROMPT_PRESETS.map((p) => p.key));
    const orphanKeys = dbKeys.map((k) => k.key).filter((k) => !presetKeys.has(k));
    return { rows, orphanKeys };
  }

  static printDriftReport(report: PromptDriftReport): void {
    const { rows, orphanKeys } = report;
    const missing = rows.filter((r) => r.state === 'MISSING');
    const drifted = rows.filter((r) => r.state === 'DRIFTED');
    const ok = rows.filter((r) => r.state === 'OK');

    for (const r of missing) console.log(`[MISSING] ${r.key} — 代码预设未入库，运行时走代码兜底（可运行种子模式初始化）`);
    for (const r of drifted) console.log(`[DRIFTED] ${r.key} — DB v${r.dbVersion} 与代码基线不一致（后台热编辑？或代码改动未执行 npm run seed:prompts:push -- ${r.key}）`);
    for (const k of orphanKeys) console.log(`[ORPHAN]  ${k} — DB 存在但代码无此预设（残留或已下线 key）`);

    console.log(`\n[PromptCheck] ${ALL_PROMPT_PRESETS.length} 个代码预设: ${ok.length} 一致, ${drifted.length} 漂移, ${missing.length} 缺失; ${orphanKeys.length} 个孤儿 key。`);
    if (drifted.length > 0 || missing.length > 0) {
      console.log('[PromptCheck] 漂移为警告级（运行时始终有代码兜底，不阻断）。');
    }
  }

  // CLI check skips gracefully when DB is unreachable.
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
