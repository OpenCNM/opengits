/**
 * LLM 网关结构化输出确定性收敛漏斗（Deterministic Convergence Funnels）
 *
 * 遵循《346准则》核心公理与架构模式：
 * 1. 认知三（Grounding Dilemma）：LLM 是外部不受信的高熵概率生成器。
 * 2. 认知四（File ≠ Cognitive Unit）：物理 OS 文件是作者实现细节，章节大纲是认知单元，严禁裸露物理扩展名。
 * 3. 公理一（First-Principles Thinking）：以确定性事实与系统物理不变式为锚，消灭伪退化。
 * 4. 架构模式二（Deterministic Convergence Funnel）：将模型的不确定性封装在确定性代码边界之内。
 *    在网关 Schema 硬闸门校验前，对模型输出执行幂等清洗、信封解包、别名对齐、长度截断与软字段自愈，
 *    确保系统主权完全在代码掌控之中，杜绝任何因模型微小格式漂移导致的流水线崩塌。
 */

/** 常见代码与文档文件扩展名模式 */
const CODE_FILE_EXTENSIONS =
  '(?:py|tsx?|jsx?|go|rs|java|cpp|cc|c|h|hpp|vue|rb|php|cs|swift|kt|scala|sh|bash|zsh|sql|json|ya?ml|toml|md|mdx)';

/** 尾随物理文件名模式（如 " train.py", " utils.py", " (types.go)", " `train.py`", " \"train.py\""） */
const TRAILING_FILE_WITH_EXT_REGEX = new RegExp(
  `[\\s,，:：(（\\["'\`]+[\\w.-]+\\.${CODE_FILE_EXTENSIONS}[)）\\]"'\`]*$`,
  'i'
);

/** 嵌入扩展名模式（如 ".py", ".go"） */
const EMBEDDED_FILE_EXT_REGEX = new RegExp(`\\.(${CODE_FILE_EXTENSIONS})\\b`, 'gi');

/** 知名技术框架/生态白名单（严禁误杀 Node.js / Vue.js 等） */
const PRESERVED_TECH_NAMES =
  /\b(?:node|vue|next|nuxt|three|d3|react|express|nest|alpine|chart|anime|phaser|babylon|day|moment)\.js\b/i;

/** 章节尾随括号罗列符号清单模式（如 " (Domain、NewDomain 与 matcherset)", " (Command, errors)"） */
const TRAILING_PAREN_SYMBOLS_REGEX = /\s*[(（]([^()（）]+)[)）]\s*$/;

/** 章节前置抽象架构维度标签（如 "门面契约与...", "核心执行引擎: ...", "网络领域模型：..."） */
const DIMENSION_PREFIX_ZH_REGEX =
  /^(?:交付入口与门面契约|门面契约|交付入口|(?:[\u4e00-\u9fa5]{0,6})?领域模型与核心状态|(?:[\u4e00-\u9fa5]{0,6})?领域模型|核心执行引擎与管线|核心执行引擎|核心引擎|特化算法与扩展实现|特化算法与扩展|特化算法|规范约束与验证边界|规范约束与验证|规范约束)(?:[:：\s\-—–]+|[与及和]\s*)/;

const DIMENSION_PREFIX_EN_REGEX =
  /^(?:Interface\s*&\s*Facade|Domain\s*Models?\s*&\s*State|Core\s*Engine\s*(?:&\s*Pipelines?)?|Specialized\s*Implementations?|Verification\s*&\s*Invariants)(?:\s*[:：\-—–]+\s*|\s+(?:and|&)\s+)/i;

/** 判断括号内是否为罗列的代码符号或标识符清单 */
function isParenSymbolDump(inner: string): boolean {
  if (!inner) return false;
  const trimmed = inner.trim();
  if (PRESERVED_TECH_NAMES.test(trimmed) && !/[、,，]/.test(trimmed)) {
    return false;
  }
  // 包含顿号、逗号、分号
  if (/[、,，;]/.test(trimmed)) return true;
  // 包含中英文连词
  if (/(?:\s+(?:与|和|及|and|or)\s+|与)/.test(trimmed)) return true;
  // 包含代码扩展名
  if (EMBEDDED_FILE_EXT_REGEX.test(trimmed)) return true;
  // 单个代码标识符（如 multi_buffer, matcherset, train.py, Command）
  if (/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(trimmed)) return true;
  return false;
}

/**
 * 章节标题确定性物理清洗 (File ≠ Cognitive Unit)
 * 彻底消除章节名称中模型泄露的物理代码文件扩展名（如 .py, .go, .ts 等）、
 * 尾随括号罗列符号清单（如 `(A、B 与 C)`）与冗余的抽象维度套话前缀（如 `门面契约与...`），
 * 保障大纲标题符合人类认知单元标准与通俗易懂要求。
 */
export function cleanChapterName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  let cleaned = name.trim();

  // 1. 若章节末尾附带了文件全名与后缀（例如 "第 1 章: 项目全景与训练入口 train.py"）
  const trailingMatch = cleaned.match(TRAILING_FILE_WITH_EXT_REGEX);
  if (trailingMatch) {
    const rawFileToken = trailingMatch[0].replace(/^[\s,，:：(（\["'\`]+|[)）\]"'\`]+$/g, '').trim();
    if (!PRESERVED_TECH_NAMES.test(rawFileToken)) {
      const stripped = cleaned.slice(0, cleaned.length - trailingMatch[0].length).trim();
      // 检查剥除后是否保留了主干文本（防止把 "第 1 章: train.py" 剥成 "第 1 章:"）
      const substantive = stripped.replace(/^(?:第\s*\d+\s*章[:：\s]*|Chapter\s*\d+[:：\s]*)/i, '').trim();
      if (substantive.length >= 2) {
        cleaned = stripped;
      }
    }
  }

  // 2. 若章节末尾以括号罗列了代码符号清单（例如 " (Domain、NewDomain 与 matcherset)", " (Command、errors)"）
  const parenMatch = cleaned.match(TRAILING_PAREN_SYMBOLS_REGEX);
  if (parenMatch) {
    const inner = parenMatch[1].trim();
    if (isParenSymbolDump(inner)) {
      const stripped = cleaned.slice(0, cleaned.length - parenMatch[0].length).trim();
      const substantive = stripped.replace(/^(?:第\s*\d+\s*章[:：\s]*|Chapter\s*\d+[:：\s]*)/i, '').trim();
      if (substantive.length >= 2) {
        cleaned = stripped;
      }
    }
  }

  // 3. 剥除前置抽象架构维度标签（保留章号前缀，如 "第 1 章: 门面契约与域名匹配体系" -> "第 1 章: 域名匹配体系"）
  const prefixMatch = cleaned.match(/^(?:第\s*\d+\s*章[:：\s]*|Chapter\s*\d+[:：\s]*)/i);
  const chapterPrefix = prefixMatch ? prefixMatch[0] : '';
  let titleBody = cleaned.slice(chapterPrefix.length).trim();

  const zhDimMatch = titleBody.match(DIMENSION_PREFIX_ZH_REGEX);
  if (zhDimMatch) {
    const candidate = titleBody.slice(zhDimMatch[0].length).trim();
    if (candidate.length >= 3) {
      titleBody = candidate;
      if (chapterPrefix) {
        const normPrefix = chapterPrefix.trim();
        cleaned = normPrefix.endsWith('：') ? `${normPrefix}${titleBody}` : `${normPrefix} ${titleBody}`;
      } else {
        cleaned = titleBody;
      }
    }
  } else {
    const enDimMatch = titleBody.match(DIMENSION_PREFIX_EN_REGEX);
    if (enDimMatch) {
      const candidate = titleBody.slice(enDimMatch[0].length).trim();
      if (candidate.split(/\s+/).length >= 2) {
        titleBody = candidate;
        if (chapterPrefix) {
          const normPrefix = chapterPrefix.trim();
          cleaned = normPrefix.endsWith(':') ? `${normPrefix} ${titleBody}` : `${normPrefix} ${titleBody}`;
        } else {
          cleaned = titleBody;
        }
      }
    }
  }

  // 4. 若仍含有裸露的代码扩展名（例如 "第 1 章: train.py" 剥除扩展名变为 "第 1 章: train"）
  if (EMBEDDED_FILE_EXT_REGEX.test(cleaned)) {
    cleaned = cleaned
      .replace(EMBEDDED_FILE_EXT_REGEX, (match) => {
        // 保护形如 Node.js 的专有名词
        if (
          match.toLowerCase() === '.js' &&
          /(?:node|vue|next|nuxt|three|d3|react|express|nest|alpine|chart|anime|phaser|babylon|day|moment)\.js/i.test(
            cleaned
          )
        ) {
          return match;
        }
        return '';
      })
      .trim();
  }

  // 5. 清理可能残留的尾随标点（冒号、破折号、括号等）
  cleaned = cleaned.replace(/[:：\s\-_—–()（）[\]"'`]+$/, '').trim();

  return cleaned;
}

/**
 * outline_plan_v1 确定性收敛漏斗
 */
export function normalizeOutlinePlan(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    return raw;
  }

  let obj = raw as Record<string, any>;

  // 1. 信封自动下钻解包（Envelope Unwrapping）：
  // 某些模型习惯在最外层包装 { data: ... }, { result: ... }, { plan: ... }, { curriculum: ... }
  if (!Array.isArray(obj.chapters)) {
    for (const key of ['data', 'result', 'plan', 'curriculum', 'output', 'course']) {
      if (obj[key] && typeof obj[key] === 'object' && Array.isArray(obj[key].chapters)) {
        obj = { ...obj, ...obj[key] };
        break;
      }
    }
  }

  // 1b. 顶层意图模式 intentMode 归一化（Thematic Slice Intent Mode）：
  //     仅信任模型输出的 intentMode 字段，合法值（'full_repo'|'thematic_slice'）透传，
  //     非法/缺失清空为 undefined——严禁默认填 'full_repo'（Go 侧负责缺省归一），
  //     严禁在归一器中做任何意图关键词猜测（Syntax ≠ Intent，主权在确定性代码）。
  const intentModeRaw = typeof obj.intentMode === 'string' ? obj.intentMode.trim() : '';
  const intentMode: 'full_repo' | 'thematic_slice' | undefined =
    intentModeRaw === 'full_repo' || intentModeRaw === 'thematic_slice' ? intentModeRaw : undefined;
  const thematic = intentMode === 'thematic_slice';

  // 2. 章节数组别名解析（Chapters Aliasing）
  let rawChapters: unknown[] = [];
  if (Array.isArray(obj.chapters)) {
    rawChapters = obj.chapters;
  } else if (Array.isArray(obj.modules)) {
    rawChapters = obj.modules;
  } else if (Array.isArray(obj.sections)) {
    rawChapters = obj.sections;
  }

  // 若完全没有章节，保留原状交由后续 schema fail-closed 拦截（intentMode 仍随对象携带）
  if (rawChapters.length === 0) {
    return {
      ...obj,
      intentMode,
    };
  }

  // 3. 章节数量弹性裁剪（Chapters Clamping）：
  // schema 上限为 14 章。若模型规划了 15 或更多章，确定性截断为前 14 章，绝不因微小超限中断
  if (rawChapters.length > 14) {
    rawChapters = rawChapters.slice(0, 14);
  }

  // 4. 章节逐字段确定性自愈与状态机推导
  let currentMod = '';
  let modCounter = 1;
  const total = rawChapters.length;

  const healedChapters = rawChapters.map((item, idx) => {
    const ch = (item && typeof item === 'object' ? { ...item } : {}) as Record<string, any>;

    // (a) 阶段 phase 归一化与位置推导
    let phase = typeof ch.phase === 'string' ? ch.phase.trim() : '';
    if (!phase) {
      if (idx < Math.ceil(total / 3)) {
        phase = '入门';
      } else if (idx < Math.ceil((2 * total) / 3)) {
        phase = '进阶';
      } else {
        phase = '实战';
      }
    } else {
      const lower = phase.toLowerCase();
      if (phase.includes('入') || lower.includes('intro') || lower.includes('basic') || lower.includes('beginner')) {
        phase = '入门';
      } else if (phase.includes('进') || lower.includes('advanc') || lower.includes('intermedia')) {
        phase = '进阶';
      } else if (phase.includes('实') || lower.includes('practic') || lower.includes('proj')) {
        phase = '实战';
      }
    }
    ch.phase = phase;

    // (b) 模块名称 moduleTitle 归一化、前向继承与确定性推导
    let mod =
      typeof ch.moduleTitle === 'string' && ch.moduleTitle.trim().length > 0
        ? ch.moduleTitle.trim()
        : typeof ch.module_title === 'string' && ch.module_title.trim().length > 0
        ? ch.module_title.trim()
        : typeof ch.module === 'string' && ch.module.trim().length > 0
        ? ch.module.trim()
        : typeof ch.partTitle === 'string' && ch.partTitle.trim().length > 0
        ? ch.partTitle.trim()
        : '';

    if (mod) {
      currentMod = mod;
    } else if (currentMod) {
      mod = currentMod;
    } else {
      // 首章或整体缺失 moduleTitle 的极端情况：依据 phase 与序号确定性衍生
      if (thematic) {
        // 专题切片模式：严禁重新引入全仓锚定式文案，统一中立专题保底（三 phase 分支合一）
        mod = `模块 ${modCounter}: 核心专题剖析`;
      } else if (phase === '入门') {
        mod = `模块 ${modCounter}: 架构全景与环境准备`;
      } else if (phase === '进阶') {
        mod = `模块 ${modCounter}: 核心引擎与关键机制`;
      } else {
        mod = `模块 ${modCounter}: 综合实战与扩展应用`;
      }
      currentMod = mod;
    }
    if (mod.length > 120) {
      mod = mod.slice(0, 120);
    }
    ch.moduleTitle = mod;

    // (c) 章节名称 name 别名与截断及物理扩展名清洗 (File ≠ Cognitive Unit)
    let name =
      typeof ch.name === 'string' && ch.name.trim().length > 0
        ? ch.name.trim()
        : typeof ch.title === 'string' && ch.title.trim().length > 0
        ? ch.title.trim()
        : typeof ch.chapterName === 'string' && ch.chapterName.trim().length > 0
        ? ch.chapterName.trim()
        : `第 ${idx + 1} 章: 核心实现`;

    name = cleanChapterName(name);
    if (name.length > 100) {
      name = name.slice(0, 100);
    }
    ch.name = name;

    // (d) 章节摘要 summary 容错与截断
    let summary =
      typeof ch.summary === 'string' && ch.summary.trim().length > 0
        ? ch.summary.trim()
        : typeof ch.description === 'string' && ch.description.trim().length > 0
        ? ch.description.trim()
        : typeof ch.desc === 'string' && ch.desc.trim().length > 0
        ? ch.desc.trim()
        : `${name} 核心教学意图与模块职责`;

    if (summary.length > 250) {
      summary = summary.slice(0, 250);
    }
    ch.summary = summary;

    // (e) 专题聚焦文件 focusFiles 池归一（别名 focusFiles/focus_files）：
    //     数组化、逐项 trim、去空；缺失时不制造空数组键（保持 undefined，zod optional）
    const focusRaw = ch.focusFiles ?? ch.focus_files;
    let focus: string[] = [];
    if (Array.isArray(focusRaw)) {
      focus = focusRaw.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0);
    } else if (typeof focusRaw === 'string' && focusRaw.trim().length > 0) {
      focus = [focusRaw.trim()];
    }

    // (e-1) 目标路径 targetPaths 格式归一化（别名 targetPaths/paths/target_paths/files）
    let targets: string[] = [];
    const hasTargetsAlias = ch.targetPaths != null || ch.paths != null || ch.target_paths != null;
    const rawTargets = ch.targetPaths ?? ch.paths ?? ch.target_paths ?? ch.files;
    if (Array.isArray(rawTargets)) {
      targets = rawTargets
        .map((p) => (typeof p === 'string' ? p.trim() : ''))
        .filter((p) => p.length > 0);
    } else if (typeof rawTargets === 'string' && rawTargets.trim().length > 0) {
      targets = [rawTargets.trim()];
    }

    // (e-2) files 别名分流（thematic 关键修复）：专题切片模式下，模型习惯把聚焦文件
    //       清单写进 files；当 targetPaths/paths/target_paths 三个别名均缺失时，files
    //       池归入 focusFiles（而非 targetPaths 被截 4 吞掉）。非专题模式保持现行为
    //       （files → targetPaths）逐字节不变。
    if (thematic && !hasTargetsAlias && targets.length > 0) {
      focus = [...focus, ...targets];
      targets = [];
    }

    // focusFiles 收敛：去重 + 截 8（Token 预算控制）；仅非空时写入键
    focus = Array.from(new Set(focus)).slice(0, 8);
    // 别名残留擦除：原始 focusFiles/focus_files 键经 { ...item } 透传保留，
    // 必须确保不变式「键存在 ⇒ 值已归一；归一后为空 ⇒ 键不存在（undefined）」，
    // 严禁把未清洗的别名原文（空串/空白项）泄露给下游 zod 闸门与 Go 消费方
    delete ch.focus_files;
    if (focus.length > 0) {
      ch.focusFiles = focus;
    } else {
      delete ch.focusFiles;
    }

    // (e-3) README 保底条件化：仅当该章归一后 focusFiles 为空时注入，严禁给已声明
    //       聚焦文件的专题章塞进无关 README 目标；focus 非空时 targetPaths 保持 []
    if (targets.length === 0) {
      if (focus.length === 0) {
        targets = ['README.md'];
      }
    } else if (targets.length > 4) {
      targets = targets.slice(0, 4);
    }
    ch.targetPaths = targets;

    // (f) 下钻标记 drillDown 归一化
    ch.drillDown = Boolean(ch.drillDown);

    return ch;
  });

  // 5. curriculumMode 归一化
  let mode = String(obj.curriculumMode ?? '').toLowerCase().trim();
  if (mode !== 'single' && mode !== 'matrix') {
    mode = 'matrix';
  }

  // 6. needRollup 归一化（模型超额提需求是正常的，截取前 10 保底，下游 Go 侧按需截取前 3）
  let needRoll: string[] | undefined = undefined;
  if (Array.isArray(obj.needRollup)) {
    needRoll = obj.needRollup
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter((p) => p.length > 0)
      .slice(0, 10);
  }

  return {
    ...obj,
    // intentMode 键恒在：非法/缺失值为 undefined（清除 ...obj 透传的非法字面量，zod optional 可见）
    intentMode,
    curriculumMode: mode,
    chapters: healedChapters,
    ...(needRoll !== undefined ? { needRollup: needRoll } : {}),
  };
}

/**
 * outline_map_v1 确定性收敛漏斗
 */
export function normalizeOutlineMap(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    return raw;
  }

  let obj = raw as Record<string, any>;
  if (!Array.isArray(obj.chapters)) {
    for (const key of ['data', 'result', 'plan', 'curriculum', 'output']) {
      if (obj[key] && typeof obj[key] === 'object' && Array.isArray(obj[key].chapters)) {
        obj = { ...obj, ...obj[key] };
        break;
      }
    }
  }

  let rawChapters: unknown[] = [];
  if (Array.isArray(obj.chapters)) {
    rawChapters = obj.chapters;
  } else if (Array.isArray(obj.modules)) {
    rawChapters = obj.modules;
  }

  if (rawChapters.length === 0) {
    return obj;
  }

  if (rawChapters.length > 14) {
    rawChapters = rawChapters.slice(0, 14);
  }

  const total = rawChapters.length;
  const healedChapters = rawChapters.map((item, idx) => {
    const ch = (item && typeof item === 'object' ? { ...item } : {}) as Record<string, any>;

    let phase = typeof ch.phase === 'string' ? ch.phase.trim() : '';
    if (!phase) {
      if (idx < Math.ceil(total / 3)) {
        phase = '入门';
      } else if (idx < Math.ceil((2 * total) / 3)) {
        phase = '进阶';
      } else {
        phase = '实战';
      }
    }
    ch.phase = phase;

    let name =
      typeof ch.name === 'string' && ch.name.trim().length > 0
        ? ch.name.trim()
        : typeof ch.title === 'string' && ch.title.trim().length > 0
        ? ch.title.trim()
        : `第 ${idx + 1} 章: 核心导读`;
    name = cleanChapterName(name);
    if (name.length > 100) name = name.slice(0, 100);
    ch.name = name;

    let summary =
      typeof ch.summary === 'string' && ch.summary.trim().length > 0
        ? ch.summary.trim()
        : typeof ch.description === 'string' && ch.description.trim().length > 0
        ? ch.description.trim()
        : `${name} 核心设计动机与教学意图`;
    if (summary.length > 250) summary = summary.slice(0, 250);
    ch.summary = summary;

    let files: string[] = [];
    const rawFiles = ch.files ?? ch.targetPaths ?? ch.paths;
    if (Array.isArray(rawFiles)) {
      files = rawFiles.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0);
    } else if (typeof rawFiles === 'string' && rawFiles.trim().length > 0) {
      files = [rawFiles.trim()];
    }
    if (files.length === 0) {
      files = ['README.md'];
    }
    ch.files = files;

    let partTitle =
      typeof ch.partTitle === 'string' && ch.partTitle.trim().length > 0
        ? ch.partTitle.trim()
        : typeof ch.moduleTitle === 'string' && ch.moduleTitle.trim().length > 0
        ? ch.moduleTitle.trim()
        : undefined;
    if (partTitle) {
      if (partTitle.length > 100) partTitle = partTitle.slice(0, 100);
      ch.partTitle = partTitle;
    }

    return ch;
  });

  return {
    ...obj,
    chapters: healedChapters,
  };
}
