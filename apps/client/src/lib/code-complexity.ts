const ALLOWED_LANGUAGES = new Set([
  'javascript', 'js', 'jsx',
  'typescript', 'ts', 'tsx',
  'python', 'py',
  'java',
  'go',
  'rust', 'rs',
  'c', 'cpp', 'cxx', 'h', 'hpp',
  'csharp', 'cs',
  'ruby', 'rb',
  'php',
  'swift',
  'kotlin', 'kt',
  'scala',
  'solidity', 'sol',
  'dart',
  'sql',
  'shell', 'bash', 'sh' // Shell scripts rarely carry AST-like declarations and get one baseline structure point below.
]);

export function scoreCodeComplexity(codeText: string, language?: string): number {
  if (!codeText || typeof codeText !== 'string') return -100;

  const normalizedLang = (language || '').trim().toLowerCase();
  
  // Reject known non-code fences (json/yaml/text/theme names) when an explicit language tag is present.
  if (normalizedLang && !ALLOWED_LANGUAGES.has(normalizedLang)) {
    return -100;
  }

  const rawLines = codeText.split('\n');
  const nonEmpLines = rawLines.map((l) => l.trim()).filter(Boolean);

  if (nonEmpLines.length < 3) {
    return -10;
  }

  const fullText = codeText.trim();

  let structurePoints = 0;

  if (/\b(function|def|fn|func)\b/.test(fullText) || /=>/.test(fullText)) {
    structurePoints++;
  }

  if (/\b(const|let|var)\s+\w+/.test(fullText)) {
    structurePoints++;
  }

  if (/\b(if|for|while|switch|catch)\b\s*[\(\{\:]/.test(fullText)) {
    structurePoints++;
  }

  if (/\b(import|export|require)\b/.test(fullText) || /from\s+['"]/.test(fullText)) {
    structurePoints++;
  }

  if (/\breturn\b/.test(fullText)) {
    structurePoints++;
  }

  if (/\b(class|struct|interface|type)\b\s+\w+/.test(fullText)) {
    structurePoints++;
  }

  const punctuationLines = nonEmpLines.filter(l => l.endsWith(';'));
  if (punctuationLines.length / nonEmpLines.length > 0.1) {
    structurePoints++;
  }

  if (['shell', 'bash', 'sh'].includes(normalizedLang)) {
    structurePoints++;
  }

  if (structurePoints < 2) {
    return 0;
  }

  return 100;
}
