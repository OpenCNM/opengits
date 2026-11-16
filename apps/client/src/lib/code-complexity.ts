/**
 * Code Complexity Scorer (Intelligent Deep Dive Trigger)
 * Calculates a complexity score (0 - 100) based on code syntactic features
 * to determine whether the "Deep Dive (深度剖析)" button should be rendered.
 * 
 * Re-architected to a 3-Layer Defense System:
 * 1. Language Whitelist Gate (Reject unknown/theme languages)
 * 2. Structural Co-occurrence (Require multiple independent code features)
 * 3. Line Count Gate (Reject short snippets)
 */

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
  'shell', 'bash', 'sh' // Shell scripts often lack structure points, we'll give them leniency below
]);

export function scoreCodeComplexity(codeText: string, language?: string): number {
  if (!codeText || typeof codeText !== 'string') return -100;

  const normalizedLang = (language || '').trim().toLowerCase();
  
  // ==========================================
  // Layer 1: Language Whitelist Gate
  // ==========================================
  // If a language IS provided, it MUST be in the whitelist.
  // This explicitly blocks 'github-light', 'json', 'yaml', 'text', etc.
  if (normalizedLang && !ALLOWED_LANGUAGES.has(normalizedLang)) {
    return -100;
  }

  const rawLines = codeText.split('\n');
  const nonEmpLines = rawLines.map((l) => l.trim()).filter(Boolean);

  // ==========================================
  // Layer 2: Line Count Gate
  // ==========================================
  if (nonEmpLines.length < 3) {
    return -10;
  }

  const fullText = codeText.trim();

  // ==========================================
  // Layer 3: Structural Co-occurrence
  // ==========================================
  // Must satisfy at least 2 independent structural code features to be considered "complex code"
  let structurePoints = 0;

  // 3.1 Function Definitions / Arrow Functions
  if (/\b(function|def|fn|func)\b/.test(fullText) || /=>/.test(fullText)) {
    structurePoints++;
  }

  // 3.2 Variable Declarations
  if (/\b(const|let|var)\s+\w+/.test(fullText)) {
    structurePoints++;
  }

  // 3.3 Control Flow + Syntax Punctuation
  if (/\b(if|for|while|switch|catch)\b\s*[\(\{\:]/.test(fullText)) {
    structurePoints++;
  }

  // 3.4 Module / Import Statements
  if (/\b(import|export|require)\b/.test(fullText) || /from\s+['"]/.test(fullText)) {
    structurePoints++;
  }

  // 3.5 Return Statements
  if (/\breturn\b/.test(fullText)) {
    structurePoints++;
  }

  // 3.6 Class / Struct / Interface / Type Definitions
  if (/\b(class|struct|interface|type)\b\s+\w+/.test(fullText)) {
    structurePoints++;
  }

  // 3.7 Syntax Line Endings (Semicolons at the end of lines)
  const punctuationLines = nonEmpLines.filter(l => l.endsWith(';'));
  if (punctuationLines.length / nonEmpLines.length > 0.1) {
    structurePoints++;
  }

  // Shell scripts have fewer structural features, give them a free point if explicitly shell
  if (['shell', 'bash', 'sh'].includes(normalizedLang)) {
    structurePoints++;
  }

  // If it doesn't have at least 2 distinct structural features, it's not complex code
  if (structurePoints < 2) {
    return 0; // Fails the complexity threshold (0 < 15)
  }

  // Passes all 3 layers
  return 100;
}
