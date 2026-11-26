const CODE_FILE_EXTENSIONS =
  '(?:py|tsx?|jsx?|go|rs|java|cpp|cc|c|h|hpp|vue|rb|php|cs|swift|kt|scala|sh|bash|zsh|sql|json|ya?ml|toml|md|mdx)';

const TRAILING_FILE_WITH_EXT_REGEX = new RegExp(
  `[\\s,，:：(（\\["'\`]+[\\w.-]+\\.${CODE_FILE_EXTENSIONS}[)）\\]"'\`]*$`,
  'i'
);

const EMBEDDED_FILE_EXT_REGEX = new RegExp(`\\.(${CODE_FILE_EXTENSIONS})\\b`, 'gi');

// Preserve dotted ecosystem names such as Node.js and Vue.js when stripping code file extensions.
const PRESERVED_TECH_NAMES =
  /\b(?:node|vue|next|nuxt|three|d3|react|express|nest|alpine|chart|anime|phaser|babylon|day|moment)\.js\b/i;

const TRAILING_PAREN_SYMBOLS_REGEX = /\s*[(（]([^()（）]+)[)）]\s*$/;

const DIMENSION_PREFIX_ZH_REGEX =
  /^(?:交付入口与门面契约|门面契约|交付入口|(?:[\u4e00-\u9fa5]{0,6})?领域模型与核心状态|(?:[\u4e00-\u9fa5]{0,6})?领域模型|核心执行引擎与管线|核心执行引擎|核心引擎|特化算法与扩展实现|特化算法与扩展|特化算法|规范约束与验证边界|规范约束与验证|规范约束)(?:[:：\s\-—–]+|[与及和]\s*)/;

const DIMENSION_PREFIX_EN_REGEX =
  /^(?:Interface\s*&\s*Facade|Domain\s*Models?\s*&\s*State|Core\s*Engine\s*(?:&\s*Pipelines?)?|Specialized\s*Implementations?|Verification\s*&\s*Invariants)(?:\s*[:：\-—–]+\s*|\s+(?:and|&)\s+)/i;

function isParenSymbolDump(inner: string): boolean {
  if (!inner) return false;
  const trimmed = inner.trim();
  if (PRESERVED_TECH_NAMES.test(trimmed) && !/[、,，]/.test(trimmed)) {
    return false;
  }
  if (/[、,，;]/.test(trimmed)) return true;
  if (/(?:\s+(?:与|和|及|and|or)\s+|与)/.test(trimmed)) return true;
  if (EMBEDDED_FILE_EXT_REGEX.test(trimmed)) return true;
  if (/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(trimmed)) return true;
  return false;
}

export function cleanChapterName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  let cleaned = name.trim();

  const trailingMatch = cleaned.match(TRAILING_FILE_WITH_EXT_REGEX);
  if (trailingMatch) {
    const rawFileToken = trailingMatch[0].replace(/^[\s,，:：(（\["'\`]+|[)）\]"'\`]+$/g, '').trim();
    if (!PRESERVED_TECH_NAMES.test(rawFileToken)) {
      const stripped = cleaned.slice(0, cleaned.length - trailingMatch[0].length).trim();
      const substantive = stripped.replace(/^(?:第\s*\d+\s*章[:：\s]*|Chapter\s*\d+[:：\s]*)/i, '').trim();
      if (substantive.length >= 2) {
        cleaned = stripped;
      }
    }
  }

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

  if (EMBEDDED_FILE_EXT_REGEX.test(cleaned)) {
    cleaned = cleaned
      .replace(EMBEDDED_FILE_EXT_REGEX, (match) => {
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

  cleaned = cleaned.replace(/[:：\s\-_—–()（）[\]"'`]+$/, '').trim();

  return cleaned;
}

export function normalizeOutlinePlan(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    return raw;
  }

  let obj = raw as Record<string, any>;

  if (!Array.isArray(obj.chapters)) {
    for (const key of ['data', 'result', 'plan', 'curriculum', 'output', 'course']) {
      if (obj[key] && typeof obj[key] === 'object' && Array.isArray(obj[key].chapters)) {
        obj = { ...obj, ...obj[key] };
        break;
      }
    }
  }

  // Keep missing/invalid intentMode as undefined so Go defaults apply without heuristic keyword guessing.
  const intentModeRaw = typeof obj.intentMode === 'string' ? obj.intentMode.trim() : '';
  const intentMode: 'full_repo' | 'thematic_slice' | undefined =
    intentModeRaw === 'full_repo' || intentModeRaw === 'thematic_slice' ? intentModeRaw : undefined;
  const thematic = intentMode === 'thematic_slice';

  let rawChapters: unknown[] = [];
  if (Array.isArray(obj.chapters)) {
    rawChapters = obj.chapters;
  } else if (Array.isArray(obj.modules)) {
    rawChapters = obj.modules;
  } else if (Array.isArray(obj.sections)) {
    rawChapters = obj.sections;
  }

  if (rawChapters.length === 0) {
    return {
      ...obj,
      intentMode,
    };
  }

  if (rawChapters.length > 14) {
    rawChapters = rawChapters.slice(0, 14);
  }

  let currentMod = '';
  let modCounter = 1;
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
      if (thematic) {
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

    const focusRaw = ch.focusFiles ?? ch.focus_files;
    let focus: string[] = [];
    if (Array.isArray(focusRaw)) {
      focus = focusRaw.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0);
    } else if (typeof focusRaw === 'string' && focusRaw.trim().length > 0) {
      focus = [focusRaw.trim()];
    }

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

    // In thematic_slice mode, map unaliased files[] into focusFiles so the 4-item targetPaths cap does not drop them.
    if (thematic && !hasTargetsAlias && targets.length > 0) {
      focus = [...focus, ...targets];
      targets = [];
    }

    focus = Array.from(new Set(focus)).slice(0, 8);
    // Delete raw focus_files alias and omit empty focusFiles keys so uncleaned payloads never leak to Zod/Go.
    delete ch.focus_files;
    if (focus.length > 0) {
      ch.focusFiles = focus;
    } else {
      delete ch.focusFiles;
    }

    // Inject README.md fallback only when focusFiles is empty so thematic chapters never gain unrelated root targets.
    if (targets.length === 0) {
      if (focus.length === 0) {
        targets = ['README.md'];
      }
    } else if (targets.length > 4) {
      targets = targets.slice(0, 4);
    }
    ch.targetPaths = targets;

    ch.drillDown = Boolean(ch.drillDown);

    return ch;
  });

  let mode = String(obj.curriculumMode ?? '').toLowerCase().trim();
  if (mode !== 'single' && mode !== 'matrix') {
    mode = 'matrix';
  }

  let needRoll: string[] | undefined = undefined;
  if (Array.isArray(obj.needRollup)) {
    needRoll = obj.needRollup
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter((p) => p.length > 0)
      .slice(0, 10);
  }

  return {
    ...obj,
    intentMode,
    curriculumMode: mode,
    chapters: healedChapters,
    ...(needRoll !== undefined ? { needRollup: needRoll } : {}),
  };
}

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
