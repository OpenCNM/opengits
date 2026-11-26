export const CLOUD_URL = process.env.OPENGITS_CLOUD_URL || 'https://opengits.cloud';

export const DEFAULT_PLATFORM_URL = 'https://opengits.com';

export const OFFICIAL_GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_REPO_URL || 'https://github.com/OpenCNM/opengits';
export const OFFICIAL_FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL || 'https://github.com/OpenCNM/opengits/issues';
export const OFFICIAL_CHANGELOG_URL = process.env.NEXT_PUBLIC_CHANGELOG_URL || 'https://github.com/OpenCNM/opengits/releases';
export const OFFICIAL_SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@opengits.org';

export interface LanguageOption {
  code: string;
  name: string;
  nativeName?: string;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'none', name: '不翻译 (保留原版文风)', nativeName: '不翻译 (保留原版文风)' },
  { code: 'zh-CN', name: '简体中文', nativeName: '简体中文' },
  { code: 'zh-TW', name: '繁体中文', nativeName: '繁體中文' },
  { code: 'en', name: '英文', nativeName: 'English' },
  { code: 'ja', name: '日语', nativeName: '日本語' },
  { code: 'ko', name: '韩语', nativeName: '한국어' },
  { code: 'fr', name: '法语', nativeName: 'Français' },
  { code: 'de', name: '德语', nativeName: 'Deutsch' },
  { code: 'es', name: '西班牙语', nativeName: 'Español' },
  { code: 'it', name: '意大利语', nativeName: 'Italiano' },
  { code: 'ru', name: '俄语', nativeName: 'Русский' },
  { code: 'ar', name: '阿拉伯语', nativeName: 'العربية' },
  { code: 'da', name: '丹麦语', nativeName: 'Dansk' }
];

export const TRANSLATION_LANGUAGES = {
  DEFAULT_CODE: 'zh-CN',
  DEFAULT_NAME: '简体中文',
  NONE_CODE: 'none'
} as const;

// 'none' applies only to document translation; generative outputs have no source text and fall back to UI locale.
export function resolveGenerativeLanguage(
  targetLanguage: string | undefined | null,
  locale: string
): string {
  if (targetLanguage && targetLanguage !== TRANSLATION_LANGUAGES.NONE_CODE) {
    return targetLanguage;
  }
  return locale.toLowerCase().startsWith('zh') ? TRANSLATION_LANGUAGES.DEFAULT_CODE : locale;
}

export const WEB_DOC_OWNER = 'web-docs';
export const WEB_DOC_PREFIX = `${WEB_DOC_OWNER}-`;

export interface CategoryOption {
  id: string;
  label: string;
  count?: number;
}

export const KNOWN_CATEGORY_LABELS: Record<string, string> = {
  all: '全部',
  AI: 'AI / 大模型',
  Systems: '系统底层',
  Cloud: '后端与云原生',
  Web: 'Web 全栈',
  Mobile: '移动跨端',
  Gaming: '游戏图形',
  Hardware: '硬件嵌入式',
  Finance: '商业金融',
  Science: '科学计算',
  'Web Docs': '官方文档',
  Others: '综合其它',
  'AI/ML': 'AI / 大模型',
  'Artificial Intelligence': 'AI / 大模型',
  Kernel: 'Linux 内核',
  Frontend: '前端架构',
  Backend: '后端开发',
  Database: '数据库',
  DevOps: 'DevOps',
  Network: '网络协议',
  Security: '安全密码',
  'Computer Science': '计算机科学',
  'Data Science': '数据科学',
  Design: '设计',
  Economy: '经济金融',
  Gotchas: '避坑指北',
  WebDoc: '官方文档',
  'web-docs': '官方文档',
};

// Single source of truth for category aliases shared across normalization, dashboard, and badges.
export const CATEGORY_ALIASES: Record<string, string> = {
  'web docs': 'Web Docs', 'web-docs': 'Web Docs', 'web_doc': 'Web Docs',
  'webdoc': 'Web Docs', 'web-doc': 'Web Docs',
  'doc': 'Web Docs', 'documentation': 'Web Docs', 'official docs': 'Web Docs',
  '官方文档': 'Web Docs', '文档': 'Web Docs',

  'ai': 'AI', 'ai/ml': 'AI', 'ai-ml': 'AI',
  'artificial intelligence': 'AI', 'artificial-intelligence': 'AI',
  'machine learning': 'AI', 'machine-learning': 'AI',
  'llm': 'AI', 'llms': 'AI', 'deep learning': 'AI', 'deep-learning': 'AI',
  'agent': 'AI', 'agents': 'AI',
  'ai / 大模型': 'AI', '人工智能': 'AI', '大模型': 'AI', '机器学习': 'AI', '深度学习': 'AI',

  'systems': 'Systems', 'system': 'Systems', 'systems programming': 'Systems',
  'rust': 'Systems', 'zig': 'Systems', 'c': 'Systems', 'cpp': 'Systems', 'c++': 'Systems',
  'kernel': 'Systems', 'linux': 'Systems', 'ebpf': 'Systems',
  'security': 'Systems', 'crypto': 'Systems', 'cryptography': 'Systems',
  'network': 'Systems', 'networking': 'Systems', 'protocol': 'Systems',
  'os': 'Systems', 'operating system': 'Systems', 'compiler': 'Systems', 'compilers': 'Systems',
  '系统底层': 'Systems', '系统编程': 'Systems', 'linux 内核': 'Systems', '内核': 'Systems',
  '安全密码': 'Systems', '网络协议': 'Systems', '操作系统': 'Systems',

  'cloud': 'Cloud', 'cloud-native': 'Cloud', 'cloud native': 'Cloud', 'cloudnative': 'Cloud',
  'backend': 'Cloud', 'server': 'Cloud',
  'database': 'Cloud', 'databases': 'Cloud', 'db': 'Cloud', 'storage': 'Cloud',
  'devops': 'Cloud', 'dev ops': 'Cloud', 'ops': 'Cloud', 'infrastructure': 'Cloud',
  'k8s': 'Cloud', 'kubernetes': 'Cloud', 'docker': 'Cloud',
  'microservice': 'Cloud', 'microservices': 'Cloud',
  'distributed': 'Cloud', 'distributed systems': 'Cloud', 'serverless': 'Cloud',
  '云原生': 'Cloud', '后端开发': 'Cloud', '后端与云原生': 'Cloud', '后端': 'Cloud',
  '数据库': 'Cloud', '数据库与存储': 'Cloud', '微服务': 'Cloud', '分布式': 'Cloud',

  'web': 'Web', 'frontend': 'Web', 'front-end': 'Web', 'ui': 'Web',
  'fullstack': 'Web', 'full-stack': 'Web', 'web development': 'Web',
  'css': 'Web', 'html': 'Web', 'javascript': 'Web', 'js': 'Web',
  'web 全栈': 'Web', '前端架构': 'Web', '前端': 'Web', '全栈': 'Web',

  'mobile': 'Mobile', 'ios': 'Mobile', 'android': 'Mobile',
  'flutter': 'Mobile', 'swift': 'Mobile',
  'react-native': 'Mobile', 'react native': 'Mobile', 'native': 'Mobile',
  'mobile dev': 'Mobile', 'tauri': 'Mobile',
  '移动跨端': 'Mobile', '移动端': 'Mobile', '移动开发': 'Mobile',

  'gaming': 'Gaming', 'game': 'Gaming', 'games': 'Gaming', 'graphics': 'Gaming',
  'gamedev': 'Gaming', 'game development': 'Gaming',
  'unity': 'Gaming', 'godot': 'Gaming',
  'webgl': 'Gaming', 'webgpu': 'Gaming', 'opengl': 'Gaming', 'vulkan': 'Gaming',
  'rendering': 'Gaming', '3d': 'Gaming', 'computer graphics': 'Gaming',
  '游戏图形': 'Gaming', '游戏开发': 'Gaming', '计算机图形': 'Gaming',

  'hardware': 'Hardware', 'embedded': 'Hardware', 'robotics': 'Hardware', 'iot': 'Hardware',
  'arduino': 'Hardware', 'esp32': 'Hardware', 'stm32': 'Hardware',
  'risc-v': 'Hardware', 'riscv': 'Hardware', 'fpga': 'Hardware', 'ros': 'Hardware', 'circuits': 'Hardware',
  '硬件嵌入式': 'Hardware', '硬件': 'Hardware', '嵌入式': 'Hardware', '物联网': 'Hardware', '机器人': 'Hardware',

  'finance': 'Finance', 'economy': 'Finance', 'economics': 'Finance',
  'quant': 'Finance', 'quantitative': 'Finance', 'fintech': 'Finance',
  'trading': 'Finance', 'crypto trading': 'Finance', 'business': 'Finance',
  '商业金融': 'Finance', '经济金融': 'Finance', '金融': 'Finance', '量化': 'Finance', '量化金融': 'Finance',

  'science': 'Science', 'computer science': 'Science', 'computer-science': 'Science', 'cs': 'Science',
  'data science': 'Science', 'data-science': 'Science',
  'academic': 'Science', 'math': 'Science', 'mathematics': 'Science', 'physics': 'Science', 'bioinformatics': 'Science',
  '科学计算': 'Science', '计算机科学': 'Science', '数据科学': 'Science', '数学逻辑': 'Science',

  'books': 'Others', 'book': 'Others', 'ebook': 'Others', 'ebooks': 'Others',
  'awesome': 'Others', 'curated': 'Others', 'roadmap': 'Others',
  'interview': 'Others', 'handbook': 'Others', 'guide': 'Others', 'guides': 'Others',
  'classic': 'Others', 'design pattern': 'Others', 'design patterns': 'Others',
  '经典图书': 'Others', '精选合集': 'Others', '开源专著': 'Others', '技术路线图': 'Others',

  'others': 'Others', 'other': 'Others', 'imported': 'Others',
  'general': 'Others', 'misc': 'Others', 'miscellaneous': 'Others',
  'gotchas': 'Others', 'gotcha': 'Others', 'pitfall': 'Others', 'design': 'Others',
  '综合其它': 'Others', '其它': 'Others', '其他': 'Others', '未分类': 'Others', '设计': 'Others', '避坑指北': 'Others',
};

export const UNTAGGED_CATEGORIES: ReadonlySet<string> = new Set(['Web Docs', 'Others']);

export const REPO_METADATA_CATEGORIES: readonly string[] = [
  'AI',
  'Systems',
  'Cloud',
  'Web',
  'Mobile',
  'Gaming',
  'Hardware',
  'Finance',
  'Science',
  'Books',
  'Others',
];

export function normalizeCategory(cat?: string | null): string {
  if (!cat) return 'Others';
  const c = cat.trim();
  if (!c) return '';
  const lower = c.toLowerCase();
  if (CATEGORY_ALIASES[lower]) return CATEGORY_ALIASES[lower];
  if (c.includes('赛道') || c.startsWith('##')) {
    // Cloud/Serverless checks precede GPU/AI keywords so Go/Serverless tracks do not misclassify as AI.
    if (c.includes('赛道二') || c.includes('云原生') || c.includes('Serverless') || c.includes('Edge 运行时') || c.includes('微服务') || c.includes('分布式') || c.includes('Go')) {
      return 'Cloud';
    }
    if (c.includes('可重现构建') || c.includes('构建系统')) {
      return 'Systems';
    }
    if (c.includes('设计哲学') || c.includes('架构模式')) {
      return 'Cloud';
    }
    if (c.includes('GPU') || c.includes('CUDA') || c.includes('推理') || c.includes('智能体') || c.includes('Agent') || c.includes('MCP') || c.includes('LLM') || c.includes('多模态') || c.includes('深度学习') || c.includes('机器学习') || c.includes('赛道一') || c.includes('赛道九')) {
      return 'AI';
    }
    if (c.includes('系统编程') || c.includes('编译器') || c.includes('运行时') || c.includes('Rust') || c.includes('Zig') || c.includes('C/C++') || c.includes('Linux') || c.includes('内核') || c.includes('eBPF') || c.includes('I/O') || c.includes('虚拟化') || c.includes('网络') || c.includes('协议') || c.includes('网关') || c.includes('密码') || c.includes('安全') || c.includes('赛道三') || c.includes('赛道四')) {
      return 'Systems';
    }
    if (c.includes('移动') || c.includes('跨端') || c.includes('Flutter') || c.includes('Android') || c.includes('iOS') || c.includes('Swift') || c.includes('Tauri')) {
      return 'Mobile';
    }
    if (c.includes('游戏') || c.includes('图形') || c.includes('渲染') || c.includes('Unity') || c.includes('Godot') || c.includes('WebGL') || c.includes('WebGPU')) {
      return 'Gaming';
    }
    if (c.includes('硬件') || c.includes('嵌入式') || c.includes('单片机') || c.includes('Arduino') || c.includes('RISC-V') || c.includes('ROS') || c.includes('机器人')) {
      return 'Hardware';
    }
    if (c.includes('金融') || c.includes('量化') || c.includes('经济') || c.includes('商业') || c.includes('交易')) {
      return 'Finance';
    }
    if (c.includes('科学计算') || c.includes('数学') || c.includes('物理') || c.includes('生物信息') || c.includes('学术') || c.includes('计算机科学')) {
      return 'Science';
    }
    if (c.includes('数据库') || c.includes('存储') || c.includes('KV') || c.includes('向量')) {
      return 'Cloud';
    }
    if (c.includes('前端') || c.includes('Next.js') || c.includes('TypeScript') || c.includes('Web 框架') || c.includes('React') || c.includes('全栈') || c.includes('UI')) {
      return 'Web';
    }
    return 'Others';
  }
  return c;
}

export const DIMENSION_TO_CONTENT_TYPES: Record<string, string[] | undefined> = {
  all: undefined,
  docs: undefined,
  documents: undefined,
  architecture: ['prose', 'architecture', 'module_overview', 'architecture_diagram'],
  code: ['code', 'api_reference', 'function_impl', 'type_definition', 'entry_point'],
  warning: ['warning'],
  gotcha: ['warning'],
};

export const DEFAULT_TOKEN_BUDGET = 4000;

export const MCP_DOC_FULL_MAX_CHARS = 16_000;

export const REPO_PROFILE_CLUSTERS_KEY = 'codeClusters';

export const REPO_PROFILE_SUPERTOPICS_KEY = 'conceptSuperTopics';

export const MCP_QUERY_MIN_LENGTH = 1;

export const MCP_FANOUT_PER_REPO_TIMEOUT_MS = 10_000;

export const MCP_FANOUT_MAX_CONCURRENCY = 3;

export const MCP_FANOUT_DETAIL_REPOS = 3;
export const MCP_FANOUT_DETAIL_MIN_BUDGET = 256;

// Bounded in-process metadata cache (60s TTL); auth, bans, and daily quotas bypass this cache.
export const MCP_HOT_CACHE_TTL_MS = 60_000;
export const MCP_HOT_CACHE_MAX_ENTRIES = 300;

export const SESSION_CACHE_TTL_MS = 60_000;
export const SESSION_CACHE_MAX_ENTRIES = 2_048;
// Bounds SDK tool argument tree size against nested-JSON DoS.
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 2_000;

export const ADMIN_CACHE_TTL_MS = 60_000;
export const ADMIN_CACHE_MAX_ENTRIES = 256;

// BLIND_SPOT is derived solely by beacon on resultCount===0; write tools must pass SUCCESS explicitly.
export const MCP_QUERY_STATUS = ['SUCCESS', 'ERROR', 'BLIND_SPOT'] as const;

export const MCP_QUERY_DIMENSIONS = [
  'all',
  'architecture',
  'code',
  'documents',
  'gotchas',
  'error_signature',
] as const;

export interface McpToolDefinition {
  name: string;
  title: string;
  iconName: string;
  description: string;
  detailedDescription: string;
  contentTypes: string[];
}

export const DEEP_DIVE_LAYER_ATTRIBUTE = 'data-layer';
export const DEEP_DIVE_LAYER_VALUE = 'deep';
export const DEEP_DIVE_BLOCK_SELECTOR = `${DEEP_DIVE_LAYER_ATTRIBUTE}="${DEEP_DIVE_LAYER_VALUE}"`;

export const STORAGE_KEYS = {
  VAR_API_KEY: 'opengits_var_API_KEY',
  VAR_PROJECT_ID: 'opengits_var_PROJECT_ID',
  READER_DEEP_DIVE_OPEN: 'opengits-reader-deep-dive-open',
  AGENT_TUTORING_STYLE: 'opengits_agent_tutoring_style',
  AGENT_EXPLAIN_DEPTH: 'opengits_agent_explain_depth',
  AGENT_PREFERRED_LANG: 'opengits_agent_preferred_lang',
  AGENT_RESPONSE_LANG: 'opengits_agent_response_lang',
  AGENT_CUSTOM_INSTRUCTIONS: 'opengits_agent_custom_instructions',
  AGENT_APPEARANCE_MODE: 'opengits_agent_appearance_mode',
  AGENT_PROVIDER: 'opengits_agent_provider',
  AGENT_PROVIDER_NAME: 'opengits_agent_provider_name',
  AGENT_BASE_URL: 'opengits_agent_base_url',
  AGENT_API_FORMAT: 'opengits_agent_api_format',
  AGENT_MODELS_LIST: 'opengits_agent_models_list',
  AGENT_MODEL: 'opengits_agent_model',
  AGENT_PINNED: 'opengits_agent_pinned',
  FONT_SIZE: 'opengits-font-size',
  // SSR reads cookies directly to apply theme/font-size classes on <html> before hydration, preventing flash.
  FONT_SIZE_COOKIE: 'opengits-font-size',
  THEME_PREFERENCE: 'theme_preference',
  THEME_COOKIE: 'theme_preference',
  USER_MODEL_PROVIDERS: 'opengits_user_model_providers',
  GUEST_SESSION: 'opengits_guest_session',
  INGEST_PAUSED: (owner: string, repo: string) => `ingest-paused-${owner}/${repo}`,
  INGEST_PAUSE_ON_CLOSE: (owner: string, repo: string) => `ingest-pause-on-close-${owner}/${repo}`,
  WORKBENCH_DRAFT: (owner: string, repo: string) => `opengits-workbench-draft-${owner}/${repo}`,
  CLOSED_ANNOUNCEMENTS: 'opengits-closed-announcements',
  LAST_IMPORT_JOB: 'opengits-last-import-job',
  RECENT_SEARCHES: 'opengits:recent_searches',
  PARAGLIDE_LOCALE: 'PARAGLIDE_LOCALE',
  NEXT_LOCALE: 'NEXT_LOCALE',
  UPDATE_TOAST_PREF: (owner: string, repo: string) => `update_toast_pref_${owner}_${repo}`,
  DASHBOARD_KEEPALIVE_STATE: 'opengits_dashboard_keepalive',
  PENDING_IMPORT_REAUTH: 'opengits_pending_import_reauth',
  PENDING_IMPORT_REAUTH_LAST_ATTEMPT: 'opengits_pending_import_reauth_last_attempt',
  QUIZ_ENABLE_THINKING: 'quiz_enable_thinking',
  QUIZ_TOKEN_CONFIRM_DISMISSED: 'quiz_token_confirm_dismissed',
  QUIZ_DIFFICULTY: 'quiz_difficulty_pref',
  MONITOR_SESSION_SENTINEL: (sessionId: string) => `opengits-monitor-session-${sessionId}`,
  MONITOR_SESSION_SENTINEL_PREFIX: 'opengits-monitor-session-',
  TRANSCRIPTION_DOCK_TASKS: 'opengits_transcription_dock_tasks',
  CHAPTER_START_TIME: (docId: string) => `opengits:chapter_start:${docId}`,
  DIAGRAM_LENS_CACHE: (hash: string, depth: string) => `diagram_lens_${hash}_${depth}`,
  WIZARD_TARGET_LANGUAGE: 'opengits_wizard_target_language',
  WORKBENCH_REORG_CUSTOM: (owner: string, repo: string) =>
    `opengits-workbench-reorg-custom-${owner}/${repo}`,
} as const;

export const REORGANIZE_CATEGORY_IDS = ['clarify', 'compact', 'expand'] as const;
export type ReorganizeCategoryId = (typeof REORGANIZE_CATEGORY_IDS)[number];
export const REORGANIZE_CATEGORY_INTENT_IDS = ['clarify', 'compact', 'expand', 'general'] as const;
export type ReorganizeCategoryIntent = (typeof REORGANIZE_CATEGORY_INTENT_IDS)[number];

export const REORGANIZE_PACING_IDS = ['compact', 'normal', 'detailed'] as const;
export type ReorganizePacing = (typeof REORGANIZE_PACING_IDS)[number];

export const REORGANIZE_ARCHETYPE_IDS = [
  'architecture_overview',
  'deep_dive_internals',
  'cross_language_migrant',
  'pedagogical_beginner',
] as const;
export type ReorganizeLearnerArchetype = (typeof REORGANIZE_ARCHETYPE_IDS)[number];

export const REORGANIZE_CUSTOM_MAX_PER_CATEGORY = 3;
export const REORGANIZE_CHAPTER_OPTIONS_MAX = 8;
export const REORGANIZE_SHORT_LABEL_MAX = 24;

// 2x batch-import baseline gives instant reader preemption while +1/min aging prevents permanent import starvation.
export const TRANSCRIPTION_JIT_PRIORITY = 20_000;

export const FONT_SIZE_OPTIONS = ['small', 'medium', 'large'] as const;
export type FontSizeOption = (typeof FONT_SIZE_OPTIONS)[number];
export const DEFAULT_FONT_SIZE: FontSizeOption = 'medium';

export const THEME_OPTIONS = ['vercel', 'dark'] as const;
export type ThemeOption = (typeof THEME_OPTIONS)[number];
export const DEFAULT_THEME: ThemeOption = 'vercel';

export const CUSTOM_EVENTS = {
  ASK_AI: 'ask-ai',
} as const;

export const UI_TIMINGS = {
  COPY_FEEDBACK: 2000,
} as const;

export const DASHBOARD_PAGINATION = {
  SINGLE_COLUMN_PAGE_SIZE: 8,
} as const;

export const PUBLICATIONS_PAGINATION = {
  PAGE_SIZE: 10,
} as const;

import { DocumentStatus, AdminRole } from '@prisma/client';
export { DocumentStatus, AdminRole };

const CORRUPTED_PLACEHOLDER_MARKERS = [
  'CODE_BLOCK_',
  'CODEBLOCK_',
  'OPENGITS_',
  'XBFCODEBLOCK',
] as const;

// Applied to web APIs only; /api/mcp machine protocol traffic is exempt.
export const GATEWAY_SCANNER_UA_PATTERNS = [
  'sqlmap',
  'nikto',
  'acunetix',
  'dirbuster',
  'nuclei',
  'masscan',
  'nmap',
  'havij',
] as const;

export function hasCorruptionMarker(content: string | null | undefined): boolean {
  if (!content) return false;
  return CORRUPTED_PLACEHOLDER_MARKERS.some((m) => content.includes(m));
}

export function chapterDocPath(teachingOrder: number): string {
  return `chapters/${String(teachingOrder).padStart(2, '0')}.mdx`;
}

export const DEFAULT_AI_PROVIDER: 'dashscope' | 'deepseek' = 'dashscope';
export const DEFAULT_AI_MODEL = 'qwen3.6-flash';

// Synced with Go internal/doc/types.go GenerationLevel constants.
export const GENERATION_LEVEL = {
  ENHANCED: 'enhanced',
  TRANSLATED: 'translated',
  ORIGINAL: 'original',
  CODE_LESSON: 'code_lesson',
} as const;

export type GenerationLevel = (typeof GENERATION_LEVEL)[keyof typeof GENERATION_LEVEL];

export interface ProviderPreset {
  id: string;
  name: string;
  label: string;
  badgeLabel: string;
  baseUrl: string;
  apiFormat: 'openai' | 'anthropic';
  defaultModel: string;
  models: string[];
}

export const AI_PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  google: {
    id: 'google',
    name: 'Google Gemini',
    label: 'Google Gemini (AI Studio)',
    badgeLabel: '🔴 Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiFormat: 'openai',
    defaultModel: 'gemini-3.7-flash',
    models: [
      'gemini-3.7-flash',
      'gemini-3.1-pro',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    label: 'DeepSeek API',
    badgeLabel: '🔵 DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiFormat: 'openai',
    defaultModel: 'deepseek-v4-pro',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  zhipu: {
    id: 'zhipu',
    name: '智谱 GLM',
    label: '智谱 GLM (BigModel / Z.ai)',
    badgeLabel: '🟣 智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiFormat: 'openai',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5', 'glm-4-plus'],
  },
  dashscope: {
    id: 'dashscope',
    name: '阿里百炼',
    label: '阿里云百炼 (DashScope Qwen)',
    badgeLabel: '🟠 阿里百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiFormat: 'openai',
    defaultModel: 'qwen3.8-max',
    models: ['qwen3.8-max', 'qwen3.8-27b', 'qwen3.6-flash', 'qwen-max-latest', 'qwen-plus-latest'],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    label: 'OpenAI 官方',
    badgeLabel: '🟢 OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiFormat: 'openai',
    defaultModel: 'gpt-5.6-sol',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'o3-mini', 'gpt-4o'],
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    label: 'Anthropic Claude',
    badgeLabel: '🟤 Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiFormat: 'anthropic',
    defaultModel: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-haiku-4-5'],
  },
  custom: {
    id: 'custom',
    name: '自定义端点',
    label: '自定义 API 端点',
    badgeLabel: '⚪ 自定义端点',
    baseUrl: 'https://api.example.com/v1',
    apiFormat: 'openai',
    defaultModel: 'custom-model',
    models: ['custom-model'],
  },
};

export const EXPLAIN_DEPTH_OPTIONS = ['simple', 'normal', 'detailed'] as const;
export type ExplainDepth = (typeof EXPLAIN_DEPTH_OPTIONS)[number];
export const DEFAULT_EXPLAIN_DEPTH: ExplainDepth = 'simple';

export const AGENT_DEFAULTS = {
  tutoringStyle: 'socratic',
  explainDepth: DEFAULT_EXPLAIN_DEPTH,
  appearanceMode: 'spirit',
  provider: DEFAULT_AI_PROVIDER,
  model: DEFAULT_AI_MODEL,
  preferredLang: 'typescript',
  responseLang: 'zh-CN',
} as const;

export function getCorsHeaders(methods: string = 'GET, POST, OPTIONS'): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': process.env.CORS_ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };
}

export const QUIZ_DIFFICULTIES = {
  ADAPTIVE: 'adaptive',
} as const;

// Server accepts open difficulty strings (unknown values fall back to adaptive prompts); literals kept for UI.
export type QuizDifficulty = 'adaptive' | 'easy' | 'medium' | 'hard';

export const USER_MODEL_CACHE_TTL_MS = 60_000;
export const USER_MODEL_NEGATIVE_CACHE_TTL_MS = 10_000;
export const USER_MODEL_CACHE_MAX_ENTRIES = 1_024;

export const LLM_BUDGET_CACHE_TTL_MS = 30_000;
export const LLM_BUDGET_CACHE_MAX_ENTRIES = 1_024;

export const LLM_GATEWAY_PING_INTERVAL_MS = 10_000;

// Non-human service account excluded from personal shelves and public star counts.
export const SYSTEM_BATCH_TRANSCRIBER_USER_ID = 'system-batch-transcriber';
