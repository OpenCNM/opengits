import * as path from 'path';

function extToLang(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.py': 'python',
    '.json': 'json',
    '.md': 'markdown',
    '.mdx': 'mdx',
    '.html': 'html',
    '.css': 'css',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.sh': 'bash',
    '.bash': 'bash',
    '.go': 'go',
    '.rs': 'rust',
    '.c': 'c',
    '.cpp': 'cpp',
    '.java': 'java',
  };
  return map[ext.toLowerCase()] || 'text';
}

export function wrapCodeAsMdx(filePath: string, rawContent: string): string {
  const ext = path.extname(filePath);
  const lang = extToLang(ext);
  const filename = path.basename(filePath).replace(/`/g, '');
  
  // Calculate fence length so files containing ``` or longer fences never break out
  const maxBackticks = (rawContent.match(/`{3,}/g) || []).reduce((max, m) => Math.max(max, m.length), 2);
  const fence = '`'.repeat(maxBackticks + 1);
  const normalizedContent = rawContent.endsWith('\n') ? rawContent : rawContent + '\n';

  return `## 📄 \`${filename}\` <!-- path: ${filePath} -->\n\n${fence}${lang}\n${normalizedContent}${fence}\n`;
}
