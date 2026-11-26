export const markdownExtensions = ['.md', '.mdx'];

export const highPriorityMigrationPatterns = {
  keywords: [
    'changelog', 'changelogs',
    'migration', 'migrations',
    'upgrade', 'upgrades',
    'history',
    'breaking', 'breaking_changes', 'breaking-changes',
    'release', 'releases', 'release_notes', 'release-notes',
  ],
  versionPattern: /^v\d+(?:[-.a-z0-9]+)?$/i,
};

export const virtualChapterPathPrefixes = ['chapters/'];

export const conceptWorkflowTitlePatterns = [
  /流程|步骤|workflow|steps?|process|pipeline|procedure|walkthrough|guide/i,
];

export const conceptPrincipleTitlePatterns = [
  /原理|概念|机制|principles?|concepts?|fundamentals?|theory|how (?:it|this) works/i,
];

export const conceptReflectionContentPatterns = [
  /作者思考|设计哲学|为什么选择|权衡|思考|弃用|实战经验|trade-?offs?|design philosophy|why (?:we |it )?(?:choose|chose|picked)|lessons? learned|retrospective|pitfall/i,
];

export const conceptTitleStopPatterns = [
  /^(?:简介|引言|前言|序言|序|导语|结语|结尾|总结|小结|概述|概览|大纲|目录|附录|后记|致谢|参考文献|习题|练习|思考题|常见问题)\s*$/i,
  /^(?:introduction?|preface|foreword|summary|conclusion|overview|outline|toc|table of contents|appendix|afterword|references|bibliography|resources|faq|exercises?|getting started|credits?)\s*$/i,
];

export const topologyConfigPatterns = [
  /^(?:mkdocs\.yml|book\.(?:json|toml)|docusaurus\.config\.(?:js|ts)|mint\.json|astro\.config\.[a-z]+|next\.config\.[a-z]+)$/i,
  /^(?:package\.json|cargo\.toml|pyproject\.toml|go\.mod|pom\.xml|build\.gradle|requirements\.txt)$/i,
  /^(?:readme\.md|contributing\.md|changelog\.md|license)$/i,
];

export const topologyCodeExtensions = new Set([
  'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'sh',
]);

interface SubsystemDutyRule {
  pattern: RegExp;
  namePrefix: string;
  namePrefixEn: string;
  description: string;
  descriptionEn: string;
}

export const subsystemDuties: SubsystemDutyRule[] = [
  {
    pattern: /runtime|renderer|mount/i,
    namePrefix: '运行时与渲染挂载',
    namePrefixEn: 'Runtime & Renderer Mount',
    description: '负责应用实例初始化、虚拟节点比对、DOM/多端渲染与组件生命周期挂载。',
    descriptionEn: 'Responsible for instance initialization, VNode diffing, DOM/multi-target rendering and lifecycle mounting.',
  },
  {
    pattern: /compiler|parser|transform|codegen/i,
    namePrefix: '编译与代码生成',
    namePrefixEn: 'Compilation & Code Generation',
    description: '负责模板语法词法解析、AST 抽象语法树构建、静态提升优化与代码生成。',
    descriptionEn: 'Handles template lexical parsing, AST construction, static hoisting optimization, and code generation.',
  },
  {
    pattern: /reactiv|observer|signal|state/i,
    namePrefix: '响应式状态核心',
    namePrefixEn: 'Reactivity & State Core',
    description: '负责基于 Proxy/Getter 的依赖收集、Track/Trigger 响应机制与 Effect 派发。',
    descriptionEn: 'Responsible for proxy/getter dependency tracking, track/trigger reactive mechanism and Effect dispatching.',
  },
  {
    pattern: /dev|warn|debug|assert|error/i,
    namePrefix: '调试断言与错误处理',
    namePrefixEn: 'Diagnostics & Error Handling',
    description: '负责开发环境提示、类型校验、运行时异常捕获与友好堆栈格式化。',
    descriptionEn: 'Provides development warnings, type guards, runtime exception capture, and friendly stack formatting.',
  },
  {
    pattern: /ssr|server|stream/i,
    namePrefix: '服务端渲染管道',
    namePrefixEn: 'Server-Side Rendering Pipeline',
    description: '负责流式 SSR 传输、水合激活（Hydration）与跨端同构渲染逻辑。',
    descriptionEn: 'Manages streaming SSR transmission, hydration activation, and isomorphic rendering logic.',
  },
  {
    pattern: /directive|modifier/i,
    namePrefix: '内置指令与修饰符',
    namePrefixEn: 'Directives & Modifiers',
    description: '提供核心指令逻辑实现（如双向绑定、条件分支、事件修饰符等）。',
    descriptionEn: 'Provides core directive logic (e.g. two-way binding, conditional branches, event modifiers).',
  },
  {
    pattern: /component|element|vnode/i,
    namePrefix: '核心组件与节点结构',
    namePrefixEn: 'Core Components & VNodes',
    description: '负责内置组件逻辑实现（如 Transition/KeepAlive/Teleport）与虚拟 DOM 节点定义。',
    descriptionEn: 'Implements built-in components (e.g. Transition/KeepAlive/Teleport) and virtual DOM node definitions.',
  },
  {
    pattern: /util|helper|shared|common/i,
    namePrefix: '通用工具与共享基础',
    namePrefixEn: 'Utilities & Shared Helpers',
    description: '提供无副作用的底层工具函数、类型守卫、常量表与环境检测支持。',
    descriptionEn: 'Provides side-effect-free utility functions, type guards, constant tables, and environment probes.',
  },
  {
    pattern: /api|client|request|http|fetch/i,
    namePrefix: '数据通信与 API 层',
    namePrefixEn: 'Data Transport & API Layer',
    description: '负责网络请求发起、协议编解码、拦截器链路与服务端数据交换。',
    descriptionEn: 'Handles network request initiation, protocol codec, interceptor chains, and server-side data interchange.',
  },
  {
    pattern: /plugin|middleware|extension/i,
    namePrefix: '插件与中间件机制',
    namePrefixEn: 'Plugins & Middleware',
    description: '提供系统生命周期钩子接入、上下文注入与第三方生态能力扩展。',
    descriptionEn: 'Provides lifecycle hooks integration, context injection, and third-party ecosystem extension.',
  },
];
