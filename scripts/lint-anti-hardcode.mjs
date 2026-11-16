import fs from 'fs';
import path from 'path';

const ROOT_DIR = process.cwd();
const DIRS_TO_SCAN = [
  path.join(ROOT_DIR, 'apps'),
  path.join(ROOT_DIR, 'src'),
  path.join(ROOT_DIR, 'scripts'),
  path.join(ROOT_DIR, 'prisma'),
  path.join(ROOT_DIR, 'scratch'),
];

let violationsCount = 0;
let filesScannedCount = 0;

function getAllFiles(dirPath, arrayOfFiles = []) {
  if (!fs.existsSync(dirPath)) return arrayOfFiles;
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (!file.startsWith('.') && file !== 'node_modules' && file !== '.next' && file !== 'storage' && file !== 'dist' && file !== 'build' && file !== 'paraglide') {
        getAllFiles(fullPath, arrayOfFiles);
      }
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) {
      arrayOfFiles.push(fullPath);
    }
  });

  return arrayOfFiles;
}

let allFiles = [];
DIRS_TO_SCAN.forEach((dir) => {
  allFiles = getAllFiles(dir, allFiles);
});

console.log(`\n🔍 [Anti-Hardcoding Linter] Scanning ${allFiles.length} files across src/, scripts/, prisma/, scratch/ ...\n`);

allFiles.forEach((filePath) => {
  filesScannedCount++;
  const relativePath = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const prevLine = lines[index - 1] || '';
    const trimmedLine = line.trim();
    if (line.includes('lint-ignore') || prevLine.includes('lint-ignore')) return;

    // Rule HEX-001: Absolute HEX color literals in components / pages
    if ((relativePath.includes('/components/') || relativePath.includes('/app/')) &&
        !relativePath.includes('globals.css')) {
      const hexMatch = line.match(/#[0-9a-fA-F]{3,8}\b/);
      if (hexMatch) {
        console.error(`❌ [HEX-001] ${relativePath}:${lineNum} - Found raw HEX color "${hexMatch[0]}". Use Multi-Theme @theme variable instead.`);
        console.error(`   > ${line.trim()}`);
        violationsCount++;
      }
    }

    // Rule FONT-001: Font size literals below the readable baseline (12px / 0.75rem) bypassing global rem theme
    // Catches any px < 12 (incl. 8.5px, 9px, 9.5px) and any rem < 0.75 (incl. 0.5rem, 0.7rem); 12px+ and 0.75rem+ pass
    if ((relativePath.includes('/components/') || relativePath.includes('/app/')) &&
        !relativePath.includes('globals.css') && !relativePath.includes('lint-anti-hardcode')) {
      const fontMatch = line.match(/\btext-\[\s*(?:(?:\d(?:\.\d+)?|1[01](?:\.\d+)?)px|0?\.(?:[0-6]\d*|7(?:[0-4]\d*)?)rem)\s*\]/);
      if (fontMatch) {
        if (!line.includes('lint-ignore: FONT-001')) {
          console.warn(`⚠️ [FONT-001] ${relativePath}:${lineNum} - Found micro font size "${fontMatch[0]}". Consider using standard Tailwind size (text-xs, text-sm, text-base) for global font size scalability.`);
        }
      }
    }

    // Rule STORAGE-001: Raw string key literal in localStorage
    if ((relativePath.includes('/components/') || relativePath.includes('/app/')) &&
        !relativePath.includes('constants.ts') && !relativePath.includes('lint-anti-hardcode')) {
      const storageMatch = line.match(/localStorage\.(?:get|set|remove)Item\(\s*['"]([^'"]+)['"]/);
      if (storageMatch) {
        if (!line.includes('STORAGE_KEYS') && !line.includes('// lint-ignore: STORAGE-001')) {
          console.error(`❌ [STORAGE-001] ${relativePath}:${lineNum} - Found raw string key "${storageMatch[1]}" in localStorage. Use STORAGE_KEYS in src/lib/constants.ts.`);
          console.error(`   > ${line.trim()}`);
        }
      }
    }

    // Rule EVENT-001: Raw custom event string in addEventListener/dispatchEvent/Event
    if ((relativePath.includes('/components/') || relativePath.includes('/app/')) &&
        !relativePath.includes('constants.ts') && !relativePath.includes('lint-anti-hardcode')) {
      const eventMatch = line.match(/(?:addEventListener|removeEventListener|dispatchEvent|new\s+Event|new\s+CustomEvent)\(\s*['"](open-[a-z-]+|settings-updated|trigger-[a-z-]+|ask-ai|notes-updated|ui-highlight|document-context-changed)['"]/);
      if (eventMatch) {
        if (!line.includes('CUSTOM_EVENTS') && !line.includes('// lint-ignore: EVENT-001')) {
          console.error(`❌ [EVENT-001] ${relativePath}:${lineNum} - Found raw custom event string "${eventMatch[1]}". Use CUSTOM_EVENTS in src/lib/constants.ts.`);
          console.error(`   > ${line.trim()}`);
          violationsCount++;
        }
      }
    }

    // Rule BRANCH-001: Hardcoded 'main' branch in code logic
    if (!relativePath.endsWith('config.ts') && !relativePath.endsWith('constants.ts') && !relativePath.includes('lint-anti-hardcode')) {
      if (/['"`]main['"`]/.test(line)) {
        if (!line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.includes('font-mono') && !line.includes('main className=')) {
          if (line.includes('branch') || line.includes('defaultBranch') || line.includes('Target-Version') || line.includes('Fetcher(') || line.includes('Transformer(') || line.includes('where:')) {
            console.error(`❌ [BRANCH-001] ${relativePath}:${lineNum} - Found hardcoded 'main' branch name. Use ENGINE_CONFIG.defaultBranch.`);
            console.error(`   > ${line.trim()}`);
            violationsCount++;
          }
        }
      }
    }

    // Rule DOMAIN-001: Hardcoded official GitHub repo URL（应使用 lib/constants 的 OFFICIAL_GITHUB_URL / env 注入）
    if (line.includes('github.com/opengits') && !relativePath.includes('lint-anti-hardcode')) {
      if (!relativePath.endsWith('config.ts') && !relativePath.endsWith('constants.ts')) {
        console.error(`❌ [DOMAIN-001] ${relativePath}:${lineNum} - Found hardcoded official repo URL. Use OFFICIAL_GITHUB_URL from lib/constants.`);
        console.error(`   > ${line.trim()}`);
        violationsCount++;
      }
    }

    // Rule IP-001: Hardcoded 127.0.0.1 IP
    if ((line.includes("'127.0.0.1'") || line.includes('"127.0.0.1"')) && !relativePath.includes('lint-anti-hardcode')) {
      console.error(`❌ [IP-001] ${relativePath}:${lineNum} - Found hardcoded IP '127.0.0.1'. Use dynamic request IP.`);
      console.error(`   > ${line.trim()}`);
      violationsCount++;
    }

    // Rule MAGIC-001: Hardcoded pagination take/limit in API routes
    if (relativePath.startsWith('src/app/api/')) {
      if (/\btake:\s*\d+\b/.test(line) || /\blimit:\s*\d+\b/.test(line)) {
        if (!line.includes('ENGINE_CONFIG.pagination')) {
          console.error(`❌ [MAGIC-001] ${relativePath}:${lineNum} - Found magic number in pagination take/limit. Use ENGINE_CONFIG.pagination.*`);
          console.error(`   > ${line.trim()}`);
          violationsCount++;
        }
      }
    }

    // Rule PATH-001: Absolute OS file path string literal (e.g. 'C:\...' or '/Users/...')
    if ((/['"`][A-Za-z]:[\\\/]/.test(line) || /['"`]\/Users\//.test(line) || /['"`]\/home\//.test(line)) && !relativePath.includes('lint-anti-hardcode')) {
      console.error(`❌ [PATH-001] ${relativePath}:${lineNum} - Found absolute OS file path. Use relative path or process.cwd().`);
      console.error(`   > ${line.trim()}`);
      violationsCount++;
    }

    // Rule HEURISTIC-001: Inline heuristic string lists in engine modules
    if (relativePath.startsWith('src/engine/') && !relativePath.endsWith('language-map.ts') && !relativePath.includes('lint-anti-hardcode')) {
      if (line.includes('// lint-ignore: HEURISTIC-001')) {
        // Skip ignored lines
      } else if (/\[\s*['"`][^'"`]+['"`].*\]\.includes\b/.test(line)) {
        console.error(`❌ [HEURISTIC-001] ${relativePath}:${lineNum} - Found inline string array heuristic. Move to MODULE_ROLE_PATTERNS in language-map.ts.`);
        console.error(`   > ${line.trim()}`);
        violationsCount++;
      } else {
        // Exclude typeof checks from the equals count
        const cleanLine = line.replace(/typeof\s+[\w.]+\s*===\s*['"`]\w+['"`]/g, '');
        // Exclude markdown and URL prefixes like '---', 'http', 'data:', 'mailto:' from counts
        const veryCleanLine = cleanLine.replace(/['"`](---|===|!|<|>|\*|```|http|data:|mailto:|#| )['"`]/g, '');
        
        const includesCount = (veryCleanLine.match(/\.includes\(\s*['"`]/g) || []).length;
        const equalsCount = (veryCleanLine.match(/===\s*['"`]/g) || []).length + (veryCleanLine.match(/['"`]\s*===/g) || []).length;
        const endsWithCount = (veryCleanLine.match(/\.endsWith\(\s*['"`]/g) || []).length;
        const startsWithCount = (veryCleanLine.match(/\.startsWith\(\s*['"`]/g) || []).length;
        const matchCount = (veryCleanLine.match(/\.match\(\s*\/.*?\//g) || []).length;

        if (includesCount + equalsCount + endsWithCount + startsWithCount + matchCount >= 3) {
          console.error(`❌ [HEURISTIC-001] ${relativePath}:${lineNum} - Found 3+ chained string heuristics. Move to MODULE_ROLE_PATTERNS in language-map.ts.`);
          console.error(`   > ${line.trim()}`);
          violationsCount++;
        }
      }
    }

    // Rule RSC-001: Event handlers in React Server Components (files without 'use client')
    if (relativePath.endsWith('.tsx') && (relativePath.startsWith('src/app/') || relativePath.startsWith('src/components/'))) {
      const isClientComponent = content.startsWith("'use client'") || content.startsWith('"use client"') || content.includes("\n'use client'") || content.includes('\n"use client"');
      if (!isClientComponent) {
        if (/\bon[A-Z]\w*=\s*\{/.test(line)) {
          console.error(`❌ [RSC-001] ${relativePath}:${lineNum} - Found event handler in Server Component. Move to a 'use client' component or add 'use client' at top of file.`);
          console.error(`   > ${line.trim()}`);
          violationsCount++;
        }
      }
    }

    // Rule RSC-002: Raw <script> tags causing Next.js hydration warnings
    if (relativePath.endsWith('.tsx') && relativePath.startsWith('src/app/')) {
      if (/<script\b/.test(line) && !line.includes('<Script') && !line.includes('id=')) {
        console.error(`❌ [RSC-002] ${relativePath}:${lineNum} - Found raw <script> tag without id. Use Next.js <Script id="..."> or native <script id="..."> to prevent hydration warnings.`);
        console.error(`   > ${line.trim()}`);
        violationsCount++;
      }
    }

    // Rule RSC-003: next/script beforeInteractive in React 19 RootLayout
    if (relativePath.endsWith('layout.tsx')) {
      if (line.includes('<Script') || line.includes('strategy="beforeInteractive"')) {
        console.error(`❌ [RSC-003] ${relativePath}:${lineNum} - Found next/script or beforeInteractive. In React 19/Next 16, this causes "Encountered a script tag" errors. Use native <script suppressHydrationWarning> inside <head> instead.`);
        console.error(`   > ${line.trim()}`);
        violationsCount++;
      }
    }

    // Rule RSC-004: 'use client' must strictly be at line 1 of client component files
    if (index > 0 && (trimmedLine === "'use client';" || trimmedLine === '"use client";' || trimmedLine === "'use client'" || trimmedLine === '"use client"')) {
      console.error(`❌ [RSC-004] ${relativePath}:${lineNum} - 'use client' directive must be placed at the very first line of the file (before any imports).`);
      console.error(`   > ${line.trim()}`);
      violationsCount++;
    }
  });
});

console.log('\n--------------------------------------------------');
if (violationsCount > 0) {
  console.error(`💥 Anti-Hardcoding Linter failed with ${violationsCount} violations across ${filesScannedCount} files.`);
  console.error(`Please fix all violations or add "// lint-ignore: <RULE_ID>" if strictly required.`);
  process.exit(1);
} else {
  console.log(`✅ Anti-Hardcoding Linter passed! 0 violations in ${filesScannedCount} files.`);
  process.exit(0);
}
