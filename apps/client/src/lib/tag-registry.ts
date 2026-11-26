import { ignoreBestEffort } from '@/lib/best-effort';
import type { TagKind, TagSource } from '@/lib/validations/tag-registry';
import { normalizeCategory } from '@/lib/constants';

const TAG_REGISTRY_CACHE_TTL_MS = 60_000;

export const TAG_REGISTRY_MAX_NEW_PER_IMPORT = 2;

export const FALLBACK_CATEGORY = 'Others';

interface TagRegistryEntryView {
  value: string;
  kind: TagKind;
  aliases: string[];
  source: string;
}

export const DEFAULT_TAG_REGISTRY_SEED: ReadonlyArray<{
  value: string;
  kind: TagKind;
  aliases: string[];
}> = [
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
  fingerprint: string;
}

function seedToView(seed: (typeof DEFAULT_TAG_REGISTRY_SEED)[number]): TagRegistryEntryView {
  return { value: seed.value, kind: seed.kind, aliases: [...seed.aliases], source: 'seed' };
}

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

export function buildSeedTagRegistry(): ActiveTagRegistry {
  return buildRegistry(DEFAULT_TAG_REGISTRY_SEED.map(seedToView));
}

let cachedRegistry: ActiveTagRegistry | null = null;
let cacheExpiresAt = 0;

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
    ignoreBestEffort();
  }

  return buildSeedTagRegistry();
}

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase();
}

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

export function splitTagsInput(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : raw.split(/[,，、;]/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

interface ClassifiedTags {
  known: string[];
  unknown: string[];
}

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

export async function syncTagsToRegistry(kind: TagKind, values: string[], source: TagSource): Promise<void> {
  const valid = values
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= 40 && !/[\t\n\r]/.test(v));
  if (valid.length === 0) return;

  try {
    const { prisma } = await import('@/lib/db');
    await prisma.tagRegistry.createMany({
      data: valid.map((value) => ({ value, kind, source })),
      skipDuplicates: true,
    });
  } catch {
    ignoreBestEffort();
  }
}

interface ResolvedDraftTags {
  category: string | null;
  tags: string[] | null;
}

export function reconcileCategoryWithEvidence(input: {
  category?: string | null;
  tags?: string[] | null;
  summary?: string | null;
}): string {
  const currentCategory = input.category || FALLBACK_CATEGORY;
  if (currentCategory !== 'Cloud' && currentCategory !== 'Others') {
    return currentCategory;
  }

  const tagList = (input.tags || []).map((t) => t.toLowerCase().trim());
  const summaryLower = (input.summary || '').toLowerCase();

  const hasExactTag = (token: string) => tagList.some((t) => t === token.toLowerCase());
  const hasTagStartingWith = (prefix: string) => tagList.some((t) => t.startsWith(prefix.toLowerCase()));
  const hasSummaryWord = (word: string) => summaryLower.includes(word.toLowerCase());

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

  const isPureLanguageRuntime =
    (hasExactTag('runtime') && (hasExactTag('typescript') || hasExactTag('javascript') || hasExactTag('zig') || hasExactTag('rust')))
    || hasExactTag('javascriptcore')
    || hasExactTag('wasm engine')
    || hasSummaryWord('javascript 运行时')
    || hasSummaryWord('typescript 运行时');

  if (isPureLanguageRuntime) {
    return 'Systems';
  }

  const isGraphicsWorkload =
    hasExactTag('webgpu') && (hasExactTag('graphics') || hasExactTag('3d') || hasExactTag('wgsl'));

  if (isGraphicsWorkload) {
    return 'Gaming';
  }

  return currentCategory;
}

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

