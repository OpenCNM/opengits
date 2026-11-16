/**
 * ─────────────────────────────────────────────────────────────
 * 标签/分类注册表（TagRegistry）统一读取与归一化中枢
 * ─────────────────────────────────────────────────────────────
 * 设计目标：管理端维护基础词表 → AI 探测从词表中选择 → 确实不满足时
 * 受控新建（入库登记 source=ai），写入侧归一化去重，防止标签无限膨胀。
 *
 * - category：单选分类，严格封闭（canonicalize 不中即落 FALLBACK_CATEGORY）
 * - tag：多值标签，受控扩展（每次导入最多新增 MAX_NEW_TAGS_PER_IMPORT 个）
 *
 * 缓存策略沿用 credits-config 的「内存微缓存 + DB 降级」模式：
 * 管理端改动最迟 CACHE_TTL_MS 后生效，无需跨进程失效。
 */

import type { TagKind, TagSource } from '@/lib/validations/tag-registry';
import { normalizeCategory } from '@/lib/constants';

/** 词表微缓存 TTL：管理端改词表后的最大生效延迟（仅本文件消费） */
const TAG_REGISTRY_CACHE_TTL_MS = 60_000;

/** 单次导入允许受控新建的标签上限（超出部分静默丢弃，防膨胀） */
export const TAG_REGISTRY_MAX_NEW_PER_IMPORT = 2;

/** category 严格封闭的兜底值（与 KNOWN_CATEGORY_LABELS 键一致） */
export const FALLBACK_CATEGORY = 'Others';

/** 词表条目的最小视图（与 Zod TagRegistryEntry 对齐，去掉审计字段） */
interface TagRegistryEntryView {
  value: string;
  kind: TagKind;
  aliases: string[];
  source: string;
}

/**
 * 初始词表 seed：单点定义，seed 脚本与 DB 降级兜底共用，禁止他处复制。
 * value 形态与既有常量保持一致（'Web Docs'/'Computer Science' 为空格形式，
 * isWebDocRepository/KNOWN_CATEGORY_LABELS 均按此判等，禁止改成连字符）。
 */
export const DEFAULT_TAG_REGISTRY_SEED: ReadonlyArray<{
  value: string;
  kind: TagKind;
  aliases: string[];
}> = [
  // ── 核心规范认知领域（10 大核心领域 + 官方文档 + 兜底；严格封闭）──
  {
    value: 'AI',
    kind: 'CATEGORY',
    aliases: [
      'ai/ml', 'ai-ml', 'artificial intelligence', 'artificial-intelligence',
      'machine learning', 'machine-learning', 'llm', 'llms', 'deep learning',
      'deep-learning', 'agent', 'agents',
      'ai / 大模型', '人工智能', '大模型', '机器学习', '深度学习',
    ],
  },
  {
    value: 'Systems',
    kind: 'CATEGORY',
    aliases: [
      'system', 'systems', 'systems programming', 'rust', 'zig', 'c', 'cpp', 'c++',
      'kernel', 'linux', 'ebpf', 'security', 'crypto', 'cryptography',
      'network', 'networking', 'protocol', 'os', 'operating system',
      'compiler', 'compilers',
      '系统底层', '系统编程', 'linux 内核', '内核', '安全密码', '网络协议', '操作系统',
    ],
  },
  {
    value: 'Cloud',
    kind: 'CATEGORY',
    aliases: [
      'cloud-native', 'cloud native', 'cloudnative', 'backend', 'server',
      'database', 'databases', 'db', 'storage', 'devops', 'dev ops', 'ops',
      'infrastructure', 'k8s', 'kubernetes', 'docker', 'microservice',
      'microservices', 'distributed', 'distributed systems', 'serverless',
      '云原生', '后端开发', '后端与云原生', '后端', '数据库', '数据库与存储', '微服务', '分布式',
    ],
  },
  {
    value: 'Web',
    kind: 'CATEGORY',
    aliases: [
      'frontend', 'front-end', 'ui', 'fullstack', 'full-stack',
      'web development', 'css', 'html', 'javascript', 'js',
      'web 全栈', '前端架构', '前端', '全栈',
    ],
  },
  {
    value: 'Mobile',
    kind: 'CATEGORY',
    aliases: [
      'ios', 'android', 'flutter', 'swift', 'react-native', 'react native',
      'native', 'mobile dev', 'tauri',
      '移动跨端', '移动端', '移动开发',
    ],
  },
  {
    value: 'Gaming',
    kind: 'CATEGORY',
    aliases: [
      'game', 'games', 'graphics', 'gamedev', 'game development',
      'unity', 'godot', 'webgl', 'webgpu', 'opengl', 'vulkan',
      'rendering', '3d', 'computer graphics',
      '游戏图形', '游戏开发', '计算机图形',
    ],
  },
  {
    value: 'Hardware',
    kind: 'CATEGORY',
    aliases: [
      'embedded', 'robotics', 'iot', 'arduino', 'esp32', 'stm32',
      'risc-v', 'riscv', 'fpga', 'ros', 'circuits',
      '硬件嵌入式', '硬件', '嵌入式', '物联网', '机器人', '单片机',
    ],
  },
  {
    value: 'Finance',
    kind: 'CATEGORY',
    aliases: [
      'economy', 'economics', 'quant', 'quantitative', 'fintech',
      'trading', 'crypto trading', 'business',
      '商业金融', '经济金融', '金融', '量化', '量化金融', '商业分析',
    ],
  },
  {
    value: 'Science',
    kind: 'CATEGORY',
    aliases: [
      'computer science', 'computer-science', 'cs', 'data science', 'data-science',
      'academic', 'math', 'mathematics', 'physics', 'bioinformatics',
      '科学计算', '计算机科学', '数据科学', '数学逻辑', '数学', '物理',
    ],
  },
  {
    value: 'Web Docs',
    kind: 'CATEGORY',
    aliases: [
      'web-docs', 'webdocs', 'webdoc', 'web_doc', 'doc', 'documentation', 'official docs',
      '官方文档', '文档',
    ],
  },
  {
    value: 'Others',
    kind: 'CATEGORY',
    aliases: [
      'other', 'imported', 'general', 'misc', 'miscellaneous', 'gotchas', 'gotcha', 'pitfall', 'design',
      'books', 'book', 'ebook', 'ebooks', 'awesome', 'curated', 'roadmap',
      'interview', 'handbook', 'guide', 'guides', 'classic', 'design pattern', 'design patterns',
      '综合其它', '其它', '其他', '未分类', '设计', '避坑指北',
      '经典图书', '精选合集', '开源专著', '技术路线图',
    ],
  },
  // ── 基础标签（受控扩展；注意 value 全表唯一，不得与分类值重名）──
  { value: 'web-docs', kind: 'TAG', aliases: ['web-doc', 'webdoc-tag'] },
  { value: 'React', kind: 'TAG', aliases: ['reactjs'] },
  { value: 'Next.js', kind: 'TAG', aliases: ['nextjs', 'next'] },
  { value: 'TypeScript', kind: 'TAG', aliases: ['ts'] },
  { value: 'Node.js', kind: 'TAG', aliases: ['nodejs', 'node'] },
  { value: 'Python', kind: 'TAG', aliases: ['py'] },
  { value: 'LLM', kind: 'TAG', aliases: ['llms', 'large language model', 'large-language-model'] },
  { value: 'Docker', kind: 'TAG', aliases: ['containers'] },
  { value: 'PyTorch', kind: 'TAG', aliases: ['pytorch'] },
  { value: 'Rust', kind: 'TAG', aliases: ['rust-lang'] },
  { value: 'Go', kind: 'TAG', aliases: ['golang'] },
  { value: 'CUDA', kind: 'TAG', aliases: ['cuda c++', 'cuda-c++'] },
  { value: 'eBPF', kind: 'TAG', aliases: ['bpf'] },
  { value: 'Security', kind: 'TAG', aliases: ['cybersecurity'] },
  { value: 'Vulnerability', kind: 'TAG', aliases: ['vuln', 'cve'] },
  { value: 'Network', kind: 'TAG', aliases: ['networking'] },
  { value: 'Protocol', kind: 'TAG', aliases: ['protocols'] },
  { value: 'Agent', kind: 'TAG', aliases: ['ai-agent', 'ai agent'] },
  { value: 'Swift', kind: 'TAG', aliases: ['swift-lang'] },
  { value: 'Gateway', kind: 'TAG', aliases: ['api-gateway'] },
  { value: 'Awesome', kind: 'TAG', aliases: ['awesome-list'] },
  { value: 'Curated', kind: 'TAG', aliases: ['curated-list'] },
  { value: 'Serving', kind: 'TAG', aliases: ['model-serving', 'inference'] },
  { value: 'C', kind: 'TAG', aliases: ['c-lang'] },
  { value: 'C++', kind: 'TAG', aliases: ['cpp'] },
  { value: 'Zig', kind: 'TAG', aliases: ['zig-lang'] },
  { value: 'Mojo', kind: 'TAG', aliases: ['mojo-lang'] },
  { value: 'WebAssembly', kind: 'TAG', aliases: ['wasm'] },
  { value: 'WebGPU', kind: 'TAG', aliases: ['web-gpu'] },
  { value: 'Distributed Systems', kind: 'TAG', aliases: ['distributed-systems'] },
  { value: 'Fine-Tuning', kind: 'TAG', aliases: ['finetuning', 'sft', 'lora'] },
  { value: 'Quantization', kind: 'TAG', aliases: ['quant'] },
  { value: 'Speech', kind: 'TAG', aliases: ['audio', 'asr'] },
  { value: 'Transformer', kind: 'TAG', aliases: ['transformers'] },
  { value: 'Automation', kind: 'TAG', aliases: ['automated'] },
  { value: 'Triton', kind: 'TAG', aliases: ['openai-triton'] },
  { value: 'RLHF', kind: 'TAG', aliases: ['dpo'] },
  { value: 'Java', kind: 'TAG', aliases: ['java-lang'] },
  { value: 'V8 Isolates', kind: 'TAG', aliases: ['v8'] },
  { value: 'Serverless GPU', kind: 'TAG', aliases: ['serverless-gpu'] },
  { value: 'Networking Standards', kind: 'TAG', aliases: ['rfc', 'standards'] },
  { value: 'Rust Compiler', kind: 'TAG', aliases: ['rustc'] },
  { value: 'System Design', kind: 'TAG', aliases: ['sys-design'] },
  { value: 'Neural Network', kind: 'TAG', aliases: ['neural-networks', 'nn'] },
  { value: 'Book', kind: 'TAG', aliases: ['books', 'ebook', 'ebooks', '图书', '专著', '经典图书'] },
  { value: 'Build System', kind: 'TAG', aliases: ['build-system', 'build-systems'] },
  { value: 'Tooling', kind: 'TAG', aliases: ['tools', 'developer-tools'] },
  { value: 'Developer Tools', kind: 'TAG', aliases: ['dev-tools', 'devtools'] },
  { value: 'Nix', kind: 'TAG', aliases: ['nixos'] },
  { value: 'Environment', kind: 'TAG', aliases: ['dev-environment'] },
  { value: 'Compiler', kind: 'TAG', aliases: ['compilers'] },
  { value: 'Interpreter', kind: 'TAG', aliases: ['interpreters'] },
  { value: 'RFC', kind: 'TAG', aliases: ['rfcs'] },
  { value: 'Specification', kind: 'TAG', aliases: ['spec', 'specs'] },
  { value: 'Runtime', kind: 'TAG', aliases: ['runtimes'] },
  { value: 'Cloud Architecture', kind: 'TAG', aliases: ['cloud-architecture'] },
  { value: 'Methodology', kind: 'TAG', aliases: ['methodologies'] },
  { value: 'Best Practices', kind: 'TAG', aliases: ['best-practices'] },
  { value: 'Course', kind: 'TAG', aliases: ['courses', 'curriculum', '课程'] },
  { value: 'Architecture', kind: 'TAG', aliases: ['software-architecture'] },
  { value: 'Game Development', kind: 'TAG', aliases: ['gamedev'] },
  { value: 'Design Patterns', kind: 'TAG', aliases: ['design-pattern', 'design patterns', '设计模式'] },
  { value: 'JavaScript', kind: 'TAG', aliases: ['js', 'ecmascript'] },
  { value: 'Graphics', kind: 'TAG', aliases: ['computer-graphics', 'rendering'] },
  { value: '3D', kind: 'TAG', aliases: ['3d-graphics'] },
  { value: 'Virtualization', kind: 'TAG', aliases: ['vm', 'hypervisor'] },
  { value: 'Emulator', kind: 'TAG', aliases: ['emulation'] },
];

interface ActiveTagRegistry {
  categories: TagRegistryEntryView[];
  tags: TagRegistryEntryView[];
  /** 词表指纹：排序后的全部规范值拼接（供调用方哈希进 LLM 缓存键，词表变更即换 key） */
  fingerprint: string;
}

function seedToView(seed: (typeof DEFAULT_TAG_REGISTRY_SEED)[number]): TagRegistryEntryView {
  return { value: seed.value, kind: seed.kind, aliases: [...seed.aliases], source: 'seed' };
}

/** 词表指纹：排序后的全部规范值拼接（调用方哈希后进 LLM 缓存键，词表变更即换 key） */
export function computeRegistryFingerprint(entries: TagRegistryEntryView[]): string {
  return entries.map((e) => e.value).sort().join('|');
}

function buildRegistry(entries: TagRegistryEntryView[]): ActiveTagRegistry {
  return {
    categories: entries.filter((e) => e.kind === 'CATEGORY'),
    tags: entries.filter((e) => e.kind === 'TAG'),
    fingerprint: computeRegistryFingerprint(entries),
  };
}

/** seed 词表快照（DB 降级路径与单测共用） */
export function buildSeedTagRegistry(): ActiveTagRegistry {
  return buildRegistry(DEFAULT_TAG_REGISTRY_SEED.map(seedToView));
}

let cachedRegistry: ActiveTagRegistry | null = null;
let cacheExpiresAt = 0;

/**
 * 获取当前生效词表（active 条目，含 60s 内存微缓存与 seed 降级）。
 * DB 为空/异常时回退 seed 常量，保证探测链路永不因词表缺位而中断。
 */
export async function getActiveTagRegistry(): Promise<ActiveTagRegistry> {
  const now = Date.now();
  if (cachedRegistry && now < cacheExpiresAt) {
    return cachedRegistry;
  }

  try {
    const { prisma } = await import('@/lib/db');
    const rows = await prisma.tagRegistry.findMany({ where: { isActive: true } });
    if (rows.length > 0) {
      cachedRegistry = buildRegistry(rows.map((row) => ({
        value: row.value,
        kind: row.kind,
        aliases: row.aliases,
        source: row.source,
      })));
      cacheExpiresAt = now + TAG_REGISTRY_CACHE_TTL_MS;
      return cachedRegistry;
    }
  } catch {
    // 数据库未就绪或表未迁移时优雅降级到 seed 词表
  }

  return buildSeedTagRegistry();
}

/** 归一化匹配键：仅 trim + 小写（不做空白折叠——'Web Docs' 与 'web-docs' 必须可区分） */
function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 规范化单个标签值：只在 kind 指定池中匹配规范值/别名（严格池隔离——
 * 'web-docs' 在分类语境归一为 'Web Docs'、在标签语境归一为 'web-docs'，
 * 跨池兜底会串语境）。不传 kind 时按 分类池→标签池 顺序全量匹配。
 * 不中返回 null——调用方决定落 Others（category）还是登记新值（tag）。
 */
export function canonicalizeTag(raw: string, registry: ActiveTagRegistry, kind?: TagKind): string | null {
  const key = normalizeKey(raw);
  if (!key) return null;

  const pools = kind ? [registry[kind === 'CATEGORY' ? 'categories' : 'tags']] : [registry.categories, registry.tags];
  for (const pool of pools) {
    for (const entry of pool) {
      if (normalizeKey(entry.value) === key) return entry.value;
      if (entry.aliases.some((alias) => normalizeKey(alias) === key)) return entry.value;
    }
  }
  return null;
}

/** 拆分用户/AI 的原始 tags 输入（兼容单个字符串与数组、中英文逗号/顿号/分号） */
export function splitTagsInput(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : raw.split(/[,，、;]/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

interface ClassifiedTags {
  /** 命中词表的规范值 */
  known: string[];
  /** 词表外的新值（trim 后原样保留，交由 syncTagsToRegistry 登记） */
  unknown: string[];
}

/**
 * 批量分类（kind 决定优先匹配池）：known 去重取规范值；unknown 去重后截断到
 * TAG_REGISTRY_MAX_NEW_PER_IMPORT（防膨胀的最后一道闸）。
 */
export function classifyTags(rawList: string | string[] | null | undefined, registry: ActiveTagRegistry, kind: TagKind): ClassifiedTags {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const raw of splitTagsInput(rawList)) {
    if (raw.length > 40) continue;
    const canonical = canonicalizeTag(raw, registry, kind);
    if (canonical) {
      if (!known.includes(canonical)) known.push(canonical);
    } else {
      const candidate = raw.trim();
      if (candidate && !unknown.some((u) => normalizeKey(u) === normalizeKey(candidate))) {
        unknown.push(candidate);
      }
    }
  }
  return { known, unknown: unknown.slice(0, TAG_REGISTRY_MAX_NEW_PER_IMPORT) };
}

/**
 * 把词表外新值登记进注册表（幂等；已存在者不动其 kind/source）。
 * 并发创建撞 unique 时静默吞掉——对方已登记，语义等价。
 * 登记失败不阻断导入主链路（标签照常写入仓库）。
 */
export async function syncTagsToRegistry(kind: TagKind, values: string[], source: TagSource): Promise<void> {
  const valid = values
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= 40 && !/[\t\n\r]/.test(v));
  if (valid.length === 0) return;

  try {
    const { prisma } = await import('@/lib/db');
    // createMany + skipDuplicates（性能修复 2026-10-13）：upsert 的 update 为空
    // 即纯"不存在则建"——skipDuplicates 的 ON CONFLICT DO NOTHING 语义等价
    // （含并发竞态：对方已创建同名条目时跳过），且 N 次往返合并为 1 次
    await prisma.tagRegistry.createMany({
      data: valid.map((value) => ({ value, kind, source })),
      skipDuplicates: true,
    });
  } catch {
    // 词表登记失败不阻断导入主链路
  }
}

interface ResolvedDraftTags {
  /** 大纲 LLM 伴生分类（已归一）；null = LLM 未产出，调用方沿用 options.category */
  category: string | null;
  /** 大纲 LLM 伴生标签（known 归一 + unknown 透传）；null = LLM 未产出 */
  tags: string[] | null;
}

/**
 * 基于第一性原理的分类确定性收敛漏斗（Deterministic Convergence Funnel）：
 * 物理公理：核心工作负载（Primary Workload）严格决定一级大类，运行载体/介质（如 Cloud/Serverless）作为二级标签。
 *
 * 1. AI 强特征收敛：
 *    - 无论初始分类是 Cloud、Systems 还是 Others，只要标签或描述中明确属于大模型推理、服务化、训练微调或 AI 算力
 *      （如 Fireworks, Baseten, Replicate, RunPod, Lambda Labs, Modal, Cloudflare AI 等），
 *      确定性纠偏收敛至 'AI'。
 * 2. Systems 强特征收敛：
 *    - 通用编程语言运行时、虚拟机、沙箱（如 Deno, Bun, workerd），属于执行引擎与系统底层，
 *      从误配的 Cloud 确定性纠偏收敛至 'Systems'。
 * 3. Gaming 强特征收敛：
 *    - WebGPU 底层图形学、着色器语言与游戏开发，从误配的 Cloud 确定性纠偏收敛至 'Gaming'。
 */
export function reconcileCategoryWithEvidence(input: {
  category?: string | null;
  tags?: string[] | null;
  summary?: string | null;
}): string {
  const currentCategory = input.category || FALLBACK_CATEGORY;
  // 仅对被误分入 Cloud 或兜底 Others 的仓库进行高置信度工作负载重收敛（不侵入既有 Systems/AI 等已确立领域）
  if (currentCategory !== 'Cloud' && currentCategory !== 'Others') {
    return currentCategory;
  }

  const tagList = (input.tags || []).map((t) => t.toLowerCase().trim());
  const summaryLower = (input.summary || '').toLowerCase();

  // 离散标签全等/前缀匹配（防 'storage' 误中 'rag' 等子串越界泄漏）
  const hasExactTag = (token: string) => tagList.some((t) => t === token.toLowerCase());
  const hasTagStartingWith = (prefix: string) => tagList.some((t) => t.startsWith(prefix.toLowerCase()));
  const hasSummaryWord = (word: string) => summaryLower.includes(word.toLowerCase());

  // ── 1. AI 核心载荷识别（权重最高，穿透 Cloud / Serverless 伪属性）──
  const isAiWorkload =
    hasExactTag('llm')
    || hasTagStartingWith('llm ')
    || hasExactTag('model serving')
    || hasExactTag('serving')
    || hasExactTag('inference')
    || hasExactTag('cloud gpu')
    || hasExactTag('gpu compute')
    || hasExactTag('gpu computing')
    || hasExactTag('deep learning')
    || hasExactTag('machine learning')
    || hasExactTag('fine-tuning')
    || hasExactTag('model hosting')
    || hasExactTag('edge ai')
    || hasExactTag('cloud ai')
    || hasExactTag('truss')
    || hasExactTag('cog')
    || hasExactTag('diffusion')
    || hasExactTag('transformer')
    || hasExactTag('agent')
    || hasExactTag('rag')
    || hasExactTag('pytorch')
    || hasExactTag('cuda')
    || hasExactTag('triton')
    || hasExactTag('quantization')
    || hasExactTag('lora')
    || hasSummaryWord('大模型')
    || hasSummaryWord('模型推理')
    || hasSummaryWord('推理加速')
    || hasSummaryWord('gpu 算力');

  if (isAiWorkload) {
    return 'AI';
  }

  // ── 2. Systems 核心载荷识别（通用语言运行时与引擎，排除云上 Edge Functions）──
  const isPureLanguageRuntime =
    (hasExactTag('runtime') && (hasExactTag('typescript') || hasExactTag('javascript') || hasExactTag('zig') || hasExactTag('rust')))
    || hasExactTag('javascriptcore')
    || hasExactTag('wasm engine')
    || hasSummaryWord('javascript 运行时')
    || hasSummaryWord('typescript 运行时');

  if (isPureLanguageRuntime) {
    return 'Systems';
  }

  // ── 3. Gaming 图形学识别（WebGPU 图形规范与 3D 渲染）──
  const isGraphicsWorkload =
    hasExactTag('webgpu') && (hasExactTag('graphics') || hasExactTag('3d') || hasExactTag('wgsl'));

  if (isGraphicsWorkload) {
    return 'Gaming';
  }

  return currentCategory;
}

/**
 * 解析大纲 LLM 伴生产出的 category/tags（bestUsedFor 折叠的标签版）：
 * 读 draftOutline.category/tags（unknown 安全读取，中间传输层无类型），
 * category 经封闭词表归一（不中落 Others）并经第一性原理收敛漏斗闭环；tags 走 classifyTags。
 * DB 旧 prompt 未产出该字段时整体返回 null 交由上层默认——同 resolveBestUsedFor 容错口径。
 */
export async function resolveDraftTags(draftOutline: unknown): Promise<ResolvedDraftTags> {
  const draft = (draftOutline && typeof draftOutline === 'object' ? draftOutline : {}) as {
    category?: unknown;
    tags?: unknown;
  };

  const rawCategory = typeof draft.category === 'string' ? draft.category.trim() : '';
  const rawTags = Array.isArray(draft.tags) ? draft.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0) : [];

  if (!rawCategory && rawTags.length === 0) {
    return { category: null, tags: null };
  }

  const registry = await getActiveTagRegistry();
  const normalizedCategory = rawCategory ? normalizeCategory(rawCategory) : '';
  const candidateCategory = normalizedCategory
    ? (canonicalizeTag(normalizedCategory, registry, 'CATEGORY') ?? canonicalizeTag(rawCategory, registry, 'CATEGORY') ?? FALLBACK_CATEGORY)
    : null;

  const finalTags = rawTags.length > 0
    ? (() => {
        const classified = classifyTags(rawTags, registry, 'TAG');
        return classified.known.concat(classified.unknown);
      })()
    : null;

  const finalCategory = candidateCategory
    ? reconcileCategoryWithEvidence({
        category: candidateCategory,
        tags: finalTags,
      })
    : null;

  return {
    category: finalCategory,
    tags: finalTags,
  };
}

