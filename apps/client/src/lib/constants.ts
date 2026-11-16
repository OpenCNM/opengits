// Shared configurations for User Profile Preferences & Import Settings

/**
 * OpenGits 官方云版入口（开源版自托管时无云版，链接仅用于 README/文档/升级引导）。
 * 通过 env 覆盖（自建 fork 可指向自己的实例），未设置时回退官方域名。
 */
export const CLOUD_URL = process.env.OPENGITS_CLOUD_URL || 'https://opengits.cloud';

/**
 * 平台默认公开基础域名（用于元数据路由与 SEO 绝对路径兜底，杜绝硬编码）
 */
export const DEFAULT_PLATFORM_URL = 'https://opengits.com';

/**
 * 页脚政策链接与支持邮箱装配开关（内测期默认关闭；/legal/* 路由仍可直达）。
 * 对外开放注册时开启——开始收集用户数据时隐私政策应尽早上线。
 */

/**
 * 官方 GitHub 仓库、反馈与更新日志链接（通过环境变量解耦，杜绝硬编码）
 */
export const OFFICIAL_GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_REPO_URL || 'https://github.com/opengits/opengits';
export const OFFICIAL_FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL || 'https://github.com/opengits/opengits/issues';
export const OFFICIAL_CHANGELOG_URL = process.env.NEXT_PUBLIC_CHANGELOG_URL || 'https://github.com/opengits/opengits/releases';
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

/**
 * 生成型内容（大纲/架构图语义标注）的目标语言解析。
 * `none`（不翻译）只约束文档转录——保留原文；生成型教学内容无「原文」
 * 可保，确定性回落到界面 locale（zh* → zh-CN，其余原样），杜绝把
 * 'none' 透传给 LLM 渲染成「全部文字使用 none」。
 */
export function resolveGenerativeLanguage(
  targetLanguage: string | undefined | null,
  locale: string
): string {
  if (targetLanguage && targetLanguage !== TRANSLATION_LANGUAGES.NONE_CODE) {
    return targetLanguage;
  }
  return locale.toLowerCase().startsWith('zh') ? TRANSLATION_LANGUAGES.DEFAULT_CODE : locale;
}


/** 官方网页文档库的归属命名空间（全站统一常量） */
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
  // 历史/扩展别名直接映射（确保旧 key 反查不出错）
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

/**
 * 分类别名归一注册表（单一事实来源，照 lib/languages 的 LANGUAGE_ALIASES 范本）：
 * 小写别名 → 规范类目。normalizeCategory / 仪表盘本地化 / 角标显隐共用本表，
 * 禁止在组件里重写同义清单（曾三处各抄一份：constants / CategoryChips / FeedCard）。
 */
export const CATEGORY_ALIASES: Record<string, string> = {
  // Web Docs（官方文档库，含存量 'Web Docs' 空格形式的别名）
  'web docs': 'Web Docs', 'web-docs': 'Web Docs', 'web_doc': 'Web Docs',
  'webdoc': 'Web Docs', 'web-doc': 'Web Docs',
  'doc': 'Web Docs', 'documentation': 'Web Docs', 'official docs': 'Web Docs',
  '官方文档': 'Web Docs', '文档': 'Web Docs',

  // 1. AI
  'ai': 'AI', 'ai/ml': 'AI', 'ai-ml': 'AI',
  'artificial intelligence': 'AI', 'artificial-intelligence': 'AI',
  'machine learning': 'AI', 'machine-learning': 'AI',
  'llm': 'AI', 'llms': 'AI', 'deep learning': 'AI', 'deep-learning': 'AI',
  'agent': 'AI', 'agents': 'AI',
  'ai / 大模型': 'AI', '人工智能': 'AI', '大模型': 'AI', '机器学习': 'AI', '深度学习': 'AI',

  // 2. Systems
  'systems': 'Systems', 'system': 'Systems', 'systems programming': 'Systems',
  'rust': 'Systems', 'zig': 'Systems', 'c': 'Systems', 'cpp': 'Systems', 'c++': 'Systems',
  'kernel': 'Systems', 'linux': 'Systems', 'ebpf': 'Systems',
  'security': 'Systems', 'crypto': 'Systems', 'cryptography': 'Systems',
  'network': 'Systems', 'networking': 'Systems', 'protocol': 'Systems',
  'os': 'Systems', 'operating system': 'Systems', 'compiler': 'Systems', 'compilers': 'Systems',
  '系统底层': 'Systems', '系统编程': 'Systems', 'linux 内核': 'Systems', '内核': 'Systems',
  '安全密码': 'Systems', '网络协议': 'Systems', '操作系统': 'Systems',

  // 3. Cloud
  'cloud': 'Cloud', 'cloud-native': 'Cloud', 'cloud native': 'Cloud', 'cloudnative': 'Cloud',
  'backend': 'Cloud', 'server': 'Cloud',
  'database': 'Cloud', 'databases': 'Cloud', 'db': 'Cloud', 'storage': 'Cloud',
  'devops': 'Cloud', 'dev ops': 'Cloud', 'ops': 'Cloud', 'infrastructure': 'Cloud',
  'k8s': 'Cloud', 'kubernetes': 'Cloud', 'docker': 'Cloud',
  'microservice': 'Cloud', 'microservices': 'Cloud',
  'distributed': 'Cloud', 'distributed systems': 'Cloud', 'serverless': 'Cloud',
  '云原生': 'Cloud', '后端开发': 'Cloud', '后端与云原生': 'Cloud', '后端': 'Cloud',
  '数据库': 'Cloud', '数据库与存储': 'Cloud', '微服务': 'Cloud', '分布式': 'Cloud',

  // 4. Web
  'web': 'Web', 'frontend': 'Web', 'front-end': 'Web', 'ui': 'Web',
  'fullstack': 'Web', 'full-stack': 'Web', 'web development': 'Web',
  'css': 'Web', 'html': 'Web', 'javascript': 'Web', 'js': 'Web',
  'web 全栈': 'Web', '前端架构': 'Web', '前端': 'Web', '全栈': 'Web',

  // 5. Mobile
  'mobile': 'Mobile', 'ios': 'Mobile', 'android': 'Mobile',
  'flutter': 'Mobile', 'swift': 'Mobile',
  'react-native': 'Mobile', 'react native': 'Mobile', 'native': 'Mobile',
  'mobile dev': 'Mobile', 'tauri': 'Mobile',
  '移动跨端': 'Mobile', '移动端': 'Mobile', '移动开发': 'Mobile',

  // 6. Gaming
  'gaming': 'Gaming', 'game': 'Gaming', 'games': 'Gaming', 'graphics': 'Gaming',
  'gamedev': 'Gaming', 'game development': 'Gaming',
  'unity': 'Gaming', 'godot': 'Gaming',
  'webgl': 'Gaming', 'webgpu': 'Gaming', 'opengl': 'Gaming', 'vulkan': 'Gaming',
  'rendering': 'Gaming', '3d': 'Gaming', 'computer graphics': 'Gaming',
  '游戏图形': 'Gaming', '游戏开发': 'Gaming', '计算机图形': 'Gaming',

  // 7. Hardware
  'hardware': 'Hardware', 'embedded': 'Hardware', 'robotics': 'Hardware', 'iot': 'Hardware',
  'arduino': 'Hardware', 'esp32': 'Hardware', 'stm32': 'Hardware',
  'risc-v': 'Hardware', 'riscv': 'Hardware', 'fpga': 'Hardware', 'ros': 'Hardware', 'circuits': 'Hardware',
  '硬件嵌入式': 'Hardware', '硬件': 'Hardware', '嵌入式': 'Hardware', '物联网': 'Hardware', '机器人': 'Hardware',

  // 8. Finance
  'finance': 'Finance', 'economy': 'Finance', 'economics': 'Finance',
  'quant': 'Finance', 'quantitative': 'Finance', 'fintech': 'Finance',
  'trading': 'Finance', 'crypto trading': 'Finance', 'business': 'Finance',
  '商业金融': 'Finance', '经济金融': 'Finance', '金融': 'Finance', '量化': 'Finance', '量化金融': 'Finance',

  // 9. Science
  'science': 'Science', 'computer science': 'Science', 'computer-science': 'Science', 'cs': 'Science',
  'data science': 'Science', 'data-science': 'Science',
  'academic': 'Science', 'math': 'Science', 'mathematics': 'Science', 'physics': 'Science', 'bioinformatics': 'Science',
  '科学计算': 'Science', '计算机科学': 'Science', '数据科学': 'Science', '数学逻辑': 'Science',

  // 10. Books & 综合资源 (降维收敛至 Others，形式下沉至 tags)
  'books': 'Others', 'book': 'Others', 'ebook': 'Others', 'ebooks': 'Others',
  'awesome': 'Others', 'curated': 'Others', 'roadmap': 'Others',
  'interview': 'Others', 'handbook': 'Others', 'guide': 'Others', 'guides': 'Others',
  'classic': 'Others', 'design pattern': 'Others', 'design patterns': 'Others',
  '经典图书': 'Others', '精选合集': 'Others', '开源专著': 'Others', '技术路线图': 'Others',

  // 11. Others
  'others': 'Others', 'other': 'Others', 'imported': 'Others',
  'general': 'Others', 'misc': 'Others', 'miscellaneous': 'Others',
  'gotchas': 'Others', 'gotcha': 'Others', 'pitfall': 'Others', 'design': 'Others',
  '综合其它': 'Others', '其它': 'Others', '其他': 'Others', '未分类': 'Others', '设计': 'Others', '避坑指北': 'Others',
};

/** 不展示分类角标的规范类目（官方文档/综合其它无领域标签意义，FeedCard 显隐口径） */
export const UNTAGGED_CATEGORIES: ReadonlySet<string> = new Set(['Web Docs', 'Others']);

/** 仓库领域封闭词表（UI 领域选择器 / 打标注册表 / LLM 分类伴生产出三方共用的值域 SSOT） */
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
  // 赛道提炼：将长标题自动归一化为核心技术领域，消除冗余
  if (c.includes('赛道') || c.startsWith('##')) {
    // 1. 云原生/Serverless/Edge 规则置于通用 GPU 之前，修复赛道二误判为 AI 的缺陷
    if (c.includes('赛道二') || c.includes('云原生') || c.includes('Serverless') || c.includes('Edge 运行时') || c.includes('微服务') || c.includes('分布式') || c.includes('Go')) {
      return 'Cloud';
    }
    // 2. 原赛道十（软件设计哲学、经典架构模式与可重现构建）拆解归入底层系统与云原生
    if (c.includes('可重现构建') || c.includes('构建系统')) {
      return 'Systems';
    }
    if (c.includes('设计哲学') || c.includes('架构模式')) {
      return 'Cloud';
    }
    // 3. AI 算力内核、推理与智能体
    if (c.includes('GPU') || c.includes('CUDA') || c.includes('推理') || c.includes('智能体') || c.includes('Agent') || c.includes('MCP') || c.includes('LLM') || c.includes('多模态') || c.includes('深度学习') || c.includes('机器学习') || c.includes('赛道一') || c.includes('赛道九')) {
      return 'AI';
    }
    // 4. 系统底层、内核与安全
    if (c.includes('系统编程') || c.includes('编译器') || c.includes('运行时') || c.includes('Rust') || c.includes('Zig') || c.includes('C/C++') || c.includes('Linux') || c.includes('内核') || c.includes('eBPF') || c.includes('I/O') || c.includes('虚拟化') || c.includes('网络') || c.includes('协议') || c.includes('网关') || c.includes('密码') || c.includes('安全') || c.includes('赛道三') || c.includes('赛道四')) {
      return 'Systems';
    }
    // 5. 移动端与跨端
    if (c.includes('移动') || c.includes('跨端') || c.includes('Flutter') || c.includes('Android') || c.includes('iOS') || c.includes('Swift') || c.includes('Tauri')) {
      return 'Mobile';
    }
    // 6. 游戏开发与计算机图形
    if (c.includes('游戏') || c.includes('图形') || c.includes('渲染') || c.includes('Unity') || c.includes('Godot') || c.includes('WebGL') || c.includes('WebGPU')) {
      return 'Gaming';
    }
    // 7. 硬件、嵌入式与机器人
    if (c.includes('硬件') || c.includes('嵌入式') || c.includes('单片机') || c.includes('Arduino') || c.includes('RISC-V') || c.includes('ROS') || c.includes('机器人')) {
      return 'Hardware';
    }
    // 8. 商业经济与量化金融
    if (c.includes('金融') || c.includes('量化') || c.includes('经济') || c.includes('商业') || c.includes('交易')) {
      return 'Finance';
    }
    // 9. 科学计算与数学
    if (c.includes('科学计算') || c.includes('数学') || c.includes('物理') || c.includes('生物信息') || c.includes('学术') || c.includes('计算机科学')) {
      return 'Science';
    }
    // 10. 数据库与存储
    if (c.includes('数据库') || c.includes('存储') || c.includes('KV') || c.includes('向量')) {
      return 'Cloud';
    }
    // 11. 现代 Web 与全栈
    if (c.includes('前端') || c.includes('Next.js') || c.includes('TypeScript') || c.includes('Web 框架') || c.includes('React') || c.includes('全栈') || c.includes('UI')) {
      return 'Web';
    }
    return 'Others';
  }
  return c;
}

/** 搜索维度的内容类型扇出映射（单仓检索与 Bundle 跨仓检索统一基准） */
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

// MCP 文档全文返回字符上限：防止超长文档灌爆 Agent 上下文，
// 超出部分截断并引导 read_section 按 Address 分段读取（get_document / read_section 兜底 / doc Resource 共用）
export const MCP_DOC_FULL_MAX_CHARS = 16_000;


// 入库时持久化到 Repository.repoProfile 的「课程章节 → 代码文件」映射键名（code_dep 边回填脚本消费，禁止内联）
export const REPO_PROFILE_CLUSTERS_KEY = 'codeClusters';

// L2 超主题区块在 repoProfile 中的键名（历史 LLM 凝聚管线已裁撤，现仅为
// course_map / graph 概览对存量数据的兼容读键，禁止内联）
export const REPO_PROFILE_SUPERTOPICS_KEY = 'conceptSuperTopics';

// MCP 检索工具查询串最小长度（zod 入参校验，防空串/纯空白请求产生无意义检索）
export const MCP_QUERY_MIN_LENGTH = 1;

// Hub fan-out 单仓查询超时（毫秒）：慢仓不阻塞整体扇出，超时按空命中处理
export const MCP_FANOUT_PER_REPO_TIMEOUT_MS = 10_000;

// Hub fan-out 数据库查询并发上限：防止一次跨库扇出瞬间占满连接池（与单仓超时配合，
// 超时管"单仓慢"、并发上限管"同时打多少仓"）
export const MCP_FANOUT_MAX_CONCURRENCY = 3;

// Hub fan-out detail 升级（两轮法）：轮1 locator 排序后，轮2 仅对前 K 个仓取 summary/full 正文；
// 预算按仓均分（floor(token_budget/K)），保底值防小预算下整段正文被截为空
export const MCP_FANOUT_DETAIL_REPOS = 3;
export const MCP_FANOUT_DETAIL_MIN_BUDGET = 256;

// MCP 热路径进程内缓存（B1 后 mcp 单实例长驻，进程内缓存安全）：
// - TTL：仓解析/工具策略/tier/路由层仓检查的 staleness 上限（admin 下架仓、改策略 ≤60s 生效）
// - MAX_ENTRIES：容量上限（插入序淘汰最旧），防 (repo × userId) 组合无界增长撑爆堆内存
// 鉴权/封禁/日配额账本不缓存（每次实时执行）；仅缓存元数据类读多写少数据
export const MCP_HOT_CACHE_TTL_MS = 60_000;
export const MCP_HOT_CACHE_MAX_ENTRIES = 300;

// Edge Auth Cache: NextAuth Session JWE 解密缓存与 Admin 角色查询缓存配置
export const SESSION_CACHE_TTL_MS = 60_000;
export const SESSION_CACHE_MAX_ENTRIES = 2_048;
// MCP 工具入参复杂度上限（SDK maxToolInputElements）：拦截对抗性超大/深嵌套
// arguments 的 schema 校验 DoS；正常调用入参为个位数标量字段，余量三个数量级。
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 2_000;

export const ADMIN_CACHE_TTL_MS = 60_000;
export const ADMIN_CACHE_MAX_ENTRIES = 256;

// McpCallLog 调用状态机（外脑检索流水，禁止内联）。
// BLIND_SPOT 仅由检索类工具的 resultCount===0 自动推导（beacon），写入型工具必须显式传 SUCCESS。
export const MCP_QUERY_STATUS = ['SUCCESS', 'ERROR', 'BLIND_SPOT'] as const;

// McpCallLog.dimension 实际取值注册表（beacon 写入值，禁止内联）
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

export const STORAGE_KEYS = {
  VAR_API_KEY: 'opengits_var_API_KEY',
  VAR_PROJECT_ID: 'opengits_var_PROJECT_ID',
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
  // 字号 cookie（与服务端约定同名）：SSR 读取后直接在 <html> 上直出 font-size-* class
  FONT_SIZE_COOKIE: 'opengits-font-size',
  THEME_PREFERENCE: 'theme_preference',
  USER_MODEL_PROVIDERS: 'opengits_user_model_providers',
  INGEST_PAUSED: (owner: string, repo: string) => `ingest-paused-${owner}/${repo}`,
  // 关闭页面时自动暂停转录（beacon 卸载钩子读取；默认关闭 = 关浏览器后台继续）
  INGEST_PAUSE_ON_CLOSE: (owner: string, repo: string) => `ingest-pause-on-close-${owner}/${repo}`,
  // 大纲编排未提交草稿（带时间戳与防手滑崩溃恢复）
  WORKBENCH_DRAFT: (owner: string, repo: string) => `opengits-workbench-draft-${owner}/${repo}`,
  // 已关闭的公告横幅 id 列表（JSON 数组）
  CLOSED_ANNOUNCEMENTS: 'opengits-closed-announcements',
  // 最近一次导入 Job（Phase B 重挂：关掉向导再打开可续看进行中的导入）
  LAST_IMPORT_JOB: 'opengits-last-import-job',
  RECENT_SEARCHES: 'opengits:recent_searches',
  PARAGLIDE_LOCALE: 'PARAGLIDE_LOCALE',
  NEXT_LOCALE: 'NEXT_LOCALE',
  UPDATE_TOAST_PREF: (owner: string, repo: string) => `update_toast_pref_${owner}_${repo}`,
  // 首页教程列表 KeepAlive 缓存（页码、分类、搜索、Tab、滚动位置）
  DASHBOARD_KEEPALIVE_STATE: 'opengits_dashboard_keepalive',
  // 导入向导 OAuth 重新授权中转状态（重定向回跳自动恢复向导与探测任务）
  PENDING_IMPORT_REAUTH: 'opengits_pending_import_reauth',
  PENDING_IMPORT_REAUTH_LAST_ATTEMPT: 'opengits_pending_import_reauth_last_attempt',
  // 小节测验偏好持久化（深度思考开关、Token 消耗确认免打扰、难度等级选择）
  QUIZ_ENABLE_THINKING: 'quiz_enable_thinking',
  QUIZ_TOKEN_CONFIRM_DISMISSED: 'quiz_token_confirm_dismissed',
  QUIZ_DIFFICULTY: 'quiz_difficulty_pref',
  // 前端监控崩溃推断哨兵（每会话一键，心跳刷新 ts；扫描前缀做孤儿哨兵回收）
  MONITOR_SESSION_SENTINEL: (sessionId: string) => `opengits-monitor-session-${sessionId}`,
  MONITOR_SESSION_SENTINEL_PREFIX: 'opengits-monitor-session-',
  // 后台转录悬浮胶囊任务集合（多教程/章节收起持久化）
  TRANSCRIPTION_DOCK_TASKS: 'opengits_transcription_dock_tasks',
  // 章节转录物理启动时间戳缓存（跨硬刷新防闪烁桥接）
  CHAPTER_START_TIME: (docId: string) => `opengits:chapter_start:${docId}`,
  // 流程图按需深度切换本地持久化缓存（diagram_lens_${hash(chart)}_${depth}）
  DIAGRAM_LENS_CACHE: (hash: string, depth: string) => `diagram_lens_${hash}_${depth}`,
} as const;

/**
 * JIT 插队优先级（服务端权威，客户端不可注入更高值）：
 * 批量导入基线为 10000 - 章序*20，插队权取 2 倍基线——打开未转录章节仍立即抢占，
 * 但老化加成（有效优先级 +1/分钟）可在有限时间内追平，读者流量不会永久压制整仓导入。
 * Go sidecar 侧同步钳制（TRANSCRIPTION_JIT_PRIORITY，默认一致）。
 */
export const TRANSCRIPTION_JIT_PRIORITY = 20_000;


/**
 * 阅读正文字号档位（作用域为文档正文 --reader-prose-font-size，见 globals.css 的 html.font-size-* 规则）。
 * 保持 html 根字号 1rem 不变以防止侧栏、AI 分栏与布局网格变形，并由 SSR 直出 class 避免水合跳动。
 */
export const FONT_SIZE_OPTIONS = ['small', 'medium', 'large'] as const;
export type FontSizeOption = (typeof FONT_SIZE_OPTIONS)[number];
export const DEFAULT_FONT_SIZE: FontSizeOption = 'medium';

export const CUSTOM_EVENTS = {
  ASK_AI: 'ask-ai',
} as const;

export const UI_TIMINGS = {
  COPY_FEEDBACK: 2000,          // 复制成功提示复原时间 (ms)
} as const;

export const DASHBOARD_PAGINATION = {
  SINGLE_COLUMN_PAGE_SIZE: 8,
} as const;

export const PUBLICATIONS_PAGINATION = {
  PAGE_SIZE: 10,
} as const;

import { DocumentStatus, AdminRole } from '@prisma/client';
export { DocumentStatus, AdminRole };

/**
 * 历史 LLM 损坏占位符标记：内容含任一标记即视为损坏，需重新转录。
 * 集中注册（禁止内联），供 JIT 自愈判定复用（仅本文件 hasCorruptionMarker 消费）。
 */
const CORRUPTED_PLACEHOLDER_MARKERS = [
  'CODE_BLOCK_',
  'CODEBLOCK_',
  'OPENGITS_',
  'XBFCODEBLOCK',
] as const;

/**
 * 已知高危恶意自动化扫描器 UA 特征（小写包含匹配）。
 * 集中注册（禁止在网关执行链内联），供 proxy.ts Web WAF 层消费；
 * 仅针对普通 Web API——`/api/mcp` 机器协议流量绝对豁免（MCP 零破坏原则）。
 */
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

/** 内容是否含历史损坏占位符（JIT 自愈触发条件） */
export function hasCorruptionMarker(content: string | null | undefined): boolean {
  if (!content) return false;
  return CORRUPTED_PLACEHOLDER_MARKERS.some((m) => content.includes(m));
}

/**
 * 代码教程章节文档路径约定：chapters/{NN}.mdx（两位数字前缀）。
 * 集中注册（禁止在 backfill/脚本里内联拼接），供 code_dep 回填等按 teachingOrder 反查章节文档。
 */
export function chapterDocPath(teachingOrder: number): string {
  return `chapters/${String(teachingOrder).padStart(2, '0')}.mdx`;
}

// Centralized AI Model & Provider Registry (改动默认模型只需修改此处)
export const DEFAULT_AI_PROVIDER: 'dashscope' | 'deepseek' = 'dashscope';
export const DEFAULT_AI_MODEL = 'qwen3.6-flash';

/**
 * 内容等级（2026-10 读者知情分级）：生成时写入 Document.generationLevel 的
 * 确定性事实（非内容嗅探）。与 Go 侧 internal/doc/types.go GenerationLevel*
 * 常量同值域同步。零 LLM 指纹复用继承 donor 行等级。
 */
export const GENERATION_LEVEL = {
  /** 增强+翻译一体化 / 纯增强 */
  ENHANCED: 'enhanced',
  /** 纯翻译（JIT/直连/降级保译；哨兵命中保原文亦归此级） */
  TRANSLATED: 'translated',
  /** 原文收编 / 原文保底（MDX 修复失败降级） */
  ORIGINAL: 'original',
  /** 代码章 LLM 写课 */
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

/**
 * 难度全集：服务端不限定枚举（未知值回落自适应提示词）；'easy'|'medium'|'hard'
 * 由生成端产出、MicroQuiz 展示端以字面量消费——退役的枚举常量键不再集中注册。
 */
export type QuizDifficulty = 'adaptive' | 'easy' | 'medium' | 'hard';

/** UserModelProvider 进程内解析缓存配置 */
export const USER_MODEL_CACHE_TTL_MS = 60_000;
export const USER_MODEL_NEGATIVE_CACHE_TTL_MS = 10_000;
export const USER_MODEL_CACHE_MAX_ENTRIES = 1_024;

/** LLM 平台预算门禁白名单缓存配置 */
export const LLM_BUDGET_CACHE_TTL_MS = 30_000;
export const LLM_BUDGET_CACHE_MAX_ENTRIES = 1_024;

/** LLM 网关 NDJSON 流式心跳间隔（毫秒） */
export const LLM_GATEWAY_PING_INTERVAL_MS = 10_000;


/**
 * 系统后台批量转录专职服务账号 ID（非自然人，严禁生成个人书架收藏或计入公开教程 Star）
 */
export const SYSTEM_BATCH_TRANSCRIBER_USER_ID = 'system-batch-transcriber';
