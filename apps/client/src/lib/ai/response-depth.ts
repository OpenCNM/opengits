import {
  DEFAULT_EXPLAIN_DEPTH,
  EXPLAIN_DEPTH_OPTIONS,
  type ExplainDepth,
} from '@/lib/constants';

const LEGACY_SCHEMA_MARKER = 'Respond strictly with a JSON object matching this schema:';

export function normalizeExplainDepth(value: unknown): ExplainDepth {
  if (typeof value !== 'string') return DEFAULT_EXPLAIN_DEPTH;
  const trimmed = value.trim();
  return (EXPLAIN_DEPTH_OPTIONS as readonly string[]).includes(trimmed)
    ? (trimmed as ExplainDepth)
    : DEFAULT_EXPLAIN_DEPTH;
}

// Strip trailing outputSchemaHint JSON directives from cached prompts so chat responses stay markdown.
export function stripLegacyResponseJsonInstruction(prompt: string): string {
  const markerIdx = prompt.indexOf(LEGACY_SCHEMA_MARKER);
  if (markerIdx === -1) return prompt;

  const afterMarker = prompt.slice(markerIdx);
  const fenceStart = afterMarker.indexOf('```');
  let cutEnd = prompt.length;
  if (fenceStart !== -1) {
    const fenceEnd = afterMarker.indexOf('```', fenceStart + 3);
    if (fenceEnd !== -1) {
      cutEnd = markerIdx + fenceEnd + 3;
    }
  }

  const head = prompt.slice(0, markerIdx).trimEnd();
  const tail = prompt.slice(cutEnd).trimStart();
  return tail ? `${head}\n\n${tail}` : head;
}

const DEPTH_POLICIES: Record<ExplainDepth, string> = {
  simple: `[RESPONSE DEPTH TIER: SIMPLE (简单模式 - DEFAULT)]
STRICT FORMAT & DENSITY CONTRACT:
- Preserve 100% of core facts, invariants, design rationale, and causal links — NEVER omit critical technical truths, edge-case constraints, or architectural reasons to save words.
- Translate heavy jargon into intuitive, plain-language mental models first, then anchor immediately to the exact symbols/APIs.
- Compress aggressively into tight, scannable bullets or 1-2 short paragraphs (target <= 180 words / ~250 Chinese characters unless the user asks for code). Zero filler, zero restating the prompt, no multi-level essay scaffolding.
- Output clean GitHub-flavored Markdown directly (never wrap in JSON like {"response": "..."}).`,

  normal: `[RESPONSE DEPTH TIER: NORMAL (正常模式)]
STRICT FORMAT & DENSITY CONTRACT:
- Preserve 100% of core facts, design trade-offs, invariants, and execution flow — ZERO information loss.
- Use a crisp, structured explanation (purpose -> core mechanism / data flow -> key design trade-off) with short headings or concise bullet points.
- Balance clarity and brevity (target ~200-400 words): include only the essential reasoning and minimal inline symbol references without exhaustive line-by-line narration.
- Output clean GitHub-flavored Markdown directly (never wrap in JSON like {"response": "..."}).`,

  detailed: `[RESPONSE DEPTH TIER: DETAILED (详细模式)]
STRICT FORMAT & DENSITY CONTRACT:
- Preserve 100% of architectural context, design intent, invariants, state/control flow, and trade-offs — ZERO information loss.
- Provide a thorough, multi-layered engineering breakdown (chapter/module role, step-by-step abstraction & data flow, edge cases, and concrete comparison of alternative designs).
- Use clear Markdown headings, symbol anchors, and structured lists to deliver exhaustive depth.
- Output clean GitHub-flavored Markdown directly (never wrap in JSON like {"response": "..."}).`,
};

export function buildExplainDepthDirective(depth: ExplainDepth): string {
  const normalized = normalizeExplainDepth(depth);
  return `RESPONSE DEPTH LADDER (ZERO INFORMATION LOSS INVARIANT — All 3 tiers retain 100% of factual/architectural information; ONLY cognitive packaging & verbosity change):
- simple (简单): Plain, intuitive, ultra-concise synthesis leading straight to core conclusions.
- normal (正常): Standard concise structured engineering explanation with key trade-offs.
- detailed (详细): Full multi-angle architectural and mechanism deep-dive.

CURRENTLY ACTIVE TIER:
${DEPTH_POLICIES[normalized]}`;
}
