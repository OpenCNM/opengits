/**
 * Golden Diff runner for cross-language (Node TS <-> Go Sidecar / Prisma) parity contracts.
 *
 * Reads canonical fixtures directly from `services/worker-sidecar/` and `prisma/schema.prisma`
 * without duplicating fixture files, asserts every contract invariant / byte parity,
 * and emits actual deterministic computed outputs for diffing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDITS_CONFIG, estimateRequiredCredits } from '@/lib/credits-config';
import { PENDING_CREDIT_STATUS, isTerminalPendingCreditStatus } from '@/lib/schemas/credit-grant';
import { fingerprintInputsFor } from '@/lib/transcription/fingerprint';
import { computeRequestFingerprint } from '@/lib/content-addressing';
import { extractContextSnippet, resolveDocTitle } from '@/lib/search/snippet';
import { estimateTokens, truncateToTokenBudget } from '@/lib/token-counter';
import { deriveCooccurrenceEdges, deriveCurriculumOrderEdges } from '@/lib/mcp/concept-graph-pure';
import { resolveConceptChunkAnchor } from '@/lib/mcp/concept-extractor';
import { wrapCodeAsMdx } from '@/engine/code-to-mdx';
import {
  DocumentStatus,
  TRANSCRIPTION_JOB_STATUS,
  type TranscriptionJobStatus,
} from '@/lib/state/status-vocabularies';
import { projectCourseLifecycleState } from '@/lib/state/curriculum-state-projector';
import { projectDockTutorialFacts } from '@/lib/state/dock-status-projector';
import type { ChapterDocumentInput } from '@/lib/state/curriculum-lifecycle-contract';

export const defaultExt = '.json';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readRepoText(relPath: string): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, relPath), 'utf8');
}

function readRepoJson<T = unknown>(relPath: string): T {
  return JSON.parse(readRepoText(relPath)) as T;
}

function runBillingParity(fixturePath: string) {
  const fixture = readRepoJson<{
    cases: Array<{
      name: string;
      config: Record<string, number>;
      input: { totalChars?: number; docCount?: number; isPublic?: boolean; isCodePedagogy?: boolean };
      expected: { estimatedChunks: number; baseCredits: number; finalCredits: number; rewardCredits: number };
    }>;
  }>(fixturePath);
  assert.ok(fixture.cases.length > 0, `${fixturePath} must not be empty`);

  const cases = fixture.cases.map((tc) => {
    const got = estimateRequiredCredits(tc.input, tc.config);
    assert.equal(got.estimatedChunks, tc.expected.estimatedChunks, `${tc.name}: estimatedChunks`);
    assert.equal(got.baseCredits, tc.expected.baseCredits, `${tc.name}: baseCredits`);
    assert.equal(got.finalCredits, tc.expected.finalCredits, `${tc.name}: finalCredits`);
    assert.equal(got.rewardCredits, tc.expected.rewardCredits, `${tc.name}: rewardCredits`);
    return { name: tc.name, got };
  });

  return { fixturePath, cases };
}

function runMdxFingerprintParity(fixturePath: string) {
  const fixture = readRepoJson<{
    cases: Array<{
      name: string;
      doc: { repositoryId: string; path: string; gitSha: string | null; repoProfile: Record<string, unknown> };
      model: string;
      options: Record<string, unknown>;
      expectedInputs: Record<string, unknown>;
      expectedFingerprint: string;
    }>;
  }>(fixturePath);
  assert.ok(fixture.cases.length > 0, `${fixturePath} must not be empty`);

  const results = fixture.cases.map((tc) => {
    const ctx = {
      id: 'doc-1',
      repositoryId: tc.doc.repositoryId,
      path: tc.doc.path,
      title: 'T',
      content: null,
      status: 'UNPROCESSED',
      ownerUserId: null,
      repository: { owner: 'o', repo: 'r', branch: 'main', gitSha: tc.doc.gitSha, repoProfile: tc.doc.repoProfile },
    };
    const inputs = fingerprintInputsFor(ctx as never, tc.model, tc.options as never);
    const filtered = Object.fromEntries(
      Object.entries(inputs).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    );
    assert.deepEqual(filtered, tc.expectedInputs, `${tc.name}: inputs`);
    const fp = computeRequestFingerprint(inputs);
    assert.equal(fp, tc.expectedFingerprint, `${tc.name}: fingerprint`);
    return { name: tc.name, inputs: filtered, fingerprint: fp };
  });

  return { fixturePath, results };
}

function runGoldenParity(fixtures: Record<string, string>) {
  const snippetFixture = readRepoJson<{
    snippets: Array<{ name: string; input: { text: string; query: string; maxLen?: number }; expected: string }>;
    titles: Array<{ name: string; input: { title?: string | null; path?: string | null; content?: string | null }; expected: string }>;
  }>(fixtures.searchSnippet);

  const snippets = snippetFixture.snippets.map((tc) => {
    const got = extractContextSnippet(tc.input.text, tc.input.query, tc.input.maxLen);
    assert.equal(got, tc.expected, `snippet: ${tc.name}`);
    return { name: tc.name, got };
  });
  const titles = snippetFixture.titles.map((tc) => {
    const got = resolveDocTitle(tc.input.title, tc.input.path, tc.input.content);
    assert.equal(got, tc.expected, `title: ${tc.name}`);
    return { name: tc.name, got };
  });

  const tokenFixture = readRepoJson<{
    estimateCases: Array<{ name: string; input: { text: string }; expected: number }>;
    truncateCases: Array<{ name: string; input: { text: string; maxTokens: number; suffix: string | null }; expected: string }>;
  }>(fixtures.tokenCounter);

  const tokenEstimates = tokenFixture.estimateCases.map((tc) => {
    const got = estimateTokens(tc.input.text);
    assert.equal(got, tc.expected, `estimateTokens: ${tc.name}`);
    return { name: tc.name, got };
  });
  const tokenTruncates = tokenFixture.truncateCases.map((tc) => {
    const got = tc.input.suffix !== null
      ? truncateToTokenBudget(tc.input.text, tc.input.maxTokens, tc.input.suffix)
      : truncateToTokenBudget(tc.input.text, tc.input.maxTokens);
    assert.equal(got, tc.expected, `truncateToTokenBudget: ${tc.name}`);
    return { name: tc.name, got };
  });

  const storeFixture = readRepoJson<{
    chunks: Array<Record<string, unknown>>;
    anchor_disambiguation: Array<{
      conceptName: string;
      sourceHeading?: string | null;
      anchorText?: string | null;
      principlesText: string;
      summary: string;
      expected: unknown;
    }>;
    edges: {
      cooccurrence_input: Parameters<typeof deriveCooccurrenceEdges>[0];
      cooccurrence_expected: unknown;
      curriculum_input: Parameters<typeof deriveCurriculumOrderEdges>[0];
      curriculum_expected: unknown;
    };
  }>(fixtures.storeChunks);

  const storeChunkAnchors = storeFixture.anchor_disambiguation.map((ac) => {
    const concept = {
      conceptName: ac.conceptName,
      sourceHeading: ac.sourceHeading ?? undefined,
      anchorText: ac.anchorText ?? undefined,
      slug: ac.conceptName.toLowerCase().replace(/\s+/g, '-'),
      category: 'architecture',
      principlesText: ac.principlesText,
      sopSteps: [],
      summary: ac.summary,
      subTopics: [],
      tags: [],
    };
    const got = resolveConceptChunkAnchor(concept as never, storeFixture.chunks as never);
    assert.deepEqual(got, ac.expected, `anchor_disambiguation: ${ac.conceptName}`);
    return { conceptName: ac.conceptName, got };
  });

  const cooccurrenceEdges = deriveCooccurrenceEdges(storeFixture.edges.cooccurrence_input);
  assert.deepEqual(cooccurrenceEdges, storeFixture.edges.cooccurrence_expected, 'cooccurrence_edges');

  const curriculumEdges = deriveCurriculumOrderEdges(storeFixture.edges.curriculum_input);
  assert.deepEqual(curriculumEdges, storeFixture.edges.curriculum_expected, 'curriculum_edges');

  const armorFixture = readRepoJson<{
    resolveHandles: Array<{ name?: string }>;
    sanitize: Array<{ name?: string }>;
    allocate: Array<{ name?: string }>;
  }>(fixtures.armor);
  const armorTotal = armorFixture.resolveHandles.length + armorFixture.sanitize.length + armorFixture.allocate.length;
  assert.equal(armorTotal, 26, 'armor.golden.json case count');

  return {
    snippets,
    titles,
    tokenEstimates,
    tokenTruncates,
    storeChunkAnchors,
    cooccurrenceEdges,
    curriculumEdges,
    armorFixtureCounts: {
      resolveHandles: armorFixture.resolveHandles.length,
      sanitize: armorFixture.sanitize.length,
      allocate: armorFixture.allocate.length,
      total: armorTotal,
    },
  };
}

function runCreditsParityAndSync(paths: { settleGo: string; prismaSchema: string; creditsSqlGo: string }) {
  const settleSrc = readRepoText(paths.settleGo);
  const m = settleSrc.match(/creditsConfigDefaults = settleCreditsDefaults\{([\s\S]*?)\n\}/);
  assert.ok(m, 'settle.go: creditsConfigDefaults block not found');
  const goDefaults: Record<string, number | boolean> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*(\w+):\s+(-?[\d.]+|true|false),/);
    if (kv) {
      goDefaults[kv[1]] = kv[2] === 'true' || kv[2] === 'false' ? kv[2] === 'true' : Number(kv[2]);
    }
  }

  const pairs: Array<[keyof typeof CREDITS_CONFIG, string]> = [
    ['DEFAULT_DAILY_CREDITS', 'defaultDailyCredits'],
    ['DEFAULT_RESET_INTERVAL_HOURS', 'resetIntervalHours'],
    ['MAX_CREDITS_PER_IMPORT', 'maxCreditsPerImport'],
    ['STANDARD_CHUNK_CHAR_SIZE', 'standardChunkCharSize'],
    ['CODE_PEDAGOGY_MULTIPLIER', 'codePedagogyMulti'],
    ['PUBLISH_GIFT_ENABLED', 'publishGiftEnabled'],
  ];
  assert.deepEqual(Object.keys(goDefaults).sort(), pairs.map(([, g]) => g).sort(), 'credits defaults keys');
  const tsDefaults: Record<string, number | boolean> = {};
  for (const [tsKey, goKey] of pairs) {
    tsDefaults[tsKey] = CREDITS_CONFIG[tsKey];
    assert.equal(goDefaults[goKey], CREDITS_CONFIG[tsKey], `Go ${goKey} <-> TS ${tsKey}`);
  }

  const prismaSrc = readRepoText(paths.prismaSchema);
  const modelMatch = prismaSrc.match(/model PendingCreditGrant \{[\s\S]*?\n\}/);
  assert.ok(modelMatch, 'PendingCreditGrant model not found');
  const statusLine = modelMatch[0].split('\n').find((l) => l.trim().startsWith('status '));
  assert.ok(statusLine, 'PendingCreditGrant status field not found');
  const commentValues = (statusLine.match(/\/\/\s*(.+)$/)?.[1] ?? '')
    .split('|')
    .map((v) => v.trim())
    .filter(Boolean);
  const defaultValue = statusLine.match(/@default\("([A-Z]+)"\)/)?.[1] ?? '';

  const tsValues = Object.values(PENDING_CREDIT_STATUS);
  assert.deepEqual([...commentValues].sort(), [...tsValues].sort(), 'Prisma comment vocab <-> TS');
  assert.ok(tsValues.includes(defaultValue as (typeof tsValues)[number]), 'Prisma @default in TS vocab');

  const sqlSrc = readRepoText(paths.creditsSqlGo);
  const goLiterals = new Set<string>();
  for (const block of sqlSrc.split(/-- name: \w+ :/).slice(1)) {
    if (!block.includes('PendingCreditGrant')) continue;
    for (const [, lit] of block.matchAll(/"status"\s*=\s*'([A-Z]+)'/g)) {
      goLiterals.add(lit);
    }
  }
  assert.ok(goLiterals.size > 0, 'Go credits.sql.go literals non-empty');
  for (const lit of goLiterals) {
    assert.ok(tsValues.includes(lit as (typeof tsValues)[number]), `Go SQL literal ${lit} in TS vocab`);
  }
  for (const v of tsValues) {
    assert.ok(goLiterals.has(v), `TS status ${v} consumed in Go SQL`);
  }

  const terminalMatrix = {
    UNLOCKED: isTerminalPendingCreditStatus('UNLOCKED'),
    CANCELLED: isTerminalPendingCreditStatus('CANCELLED'),
    PENDING: isTerminalPendingCreditStatus('PENDING'),
  };
  assert.deepEqual(terminalMatrix, { UNLOCKED: true, CANCELLED: false, PENDING: false });

  return {
    goDefaults,
    tsDefaults,
    prismaCommentValues: [...commentValues].sort(),
    goSqlLiterals: [...goLiterals].sort(),
    pendingCreditStatuses: [...tsValues].sort(),
    defaultStatus: defaultValue,
    terminalMatrix,
  };
}

function runSidecarContract(goldenDir: string) {
  const readContract = <T = Record<string, unknown>>(name: string): T =>
    readRepoJson<T>(path.join(goldenDir, name));

  const reviewVocab = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'];

  const ingest = readContract<{
    ok: boolean;
    notFound?: boolean;
    forbidden?: boolean;
    repository: Record<string, unknown>;
    documents?: Array<Record<string, unknown>>;
    publishRequested?: boolean;
    avgJobSeconds?: number | null;
  }>('ingest-status.response.json');

  assert.equal(ingest.ok, true);
  assert.equal(ingest.notFound, undefined);
  assert.equal(ingest.forbidden, undefined);
  for (const k of ['id', 'owner', 'repo', 'branch', 'edition', 'reviewStatus']) {
    assert.equal(typeof ingest.repository[k], 'string', `repository.${k}`);
  }
  assert.equal(typeof ingest.repository.isPublic, 'boolean');
  assert.equal(typeof ingest.repository.transcriptionPaused, 'boolean');
  assert.equal(typeof ingest.repository.transcriptionCreditsEarned, 'number');
  assert.ok(['string', 'object'].includes(typeof ingest.repository.ownerUserId));
  assert.ok(['string', 'object', 'undefined'].includes(typeof ingest.repository.publishedAt));
  assert.ok(['number', 'undefined'].includes(typeof ingest.repository.transcriptionTokens));
  assert.ok(ingest.repository.repoProfile);
  assert.ok(ingest.repository.navTree);
  assert.ok(reviewVocab.includes(String(ingest.repository.reviewStatus)));

  for (const doc of ingest.documents ?? []) {
    assert.equal(typeof doc.id, 'string');
    assert.equal(typeof doc.path, 'string');
    assert.ok(Object.values(DocumentStatus).includes(doc.status as DocumentStatus));
    assert.ok(['string', 'object', 'undefined'].includes(typeof doc.title));
    assert.ok(['string', 'object', 'undefined'].includes(typeof doc.errorMessage));
    if (doc.transcriptionJob != null) {
      const job = doc.transcriptionJob as Record<string, unknown>;
      assert.ok(Object.values(TRANSCRIPTION_JOB_STATUS).includes(job.status as TranscriptionJobStatus));
      assert.equal(typeof job.savedChunks, 'number');
      assert.ok(['number', 'object'].includes(typeof job.totalChunks));
      if (job.queuePosition !== undefined) {
        assert.equal(typeof job.queuePosition, 'number');
        assert.ok((job.queuePosition as number) >= 1);
      }
      for (const k of ['claimedAt', 'createdAt']) {
        if (job[k] !== undefined) assert.equal(typeof job[k], 'string');
      }
      if (job.startedAtMs !== undefined) assert.equal(typeof job.startedAtMs, 'number');
    }
  }

  const docs = (ingest.documents ?? []).map((d) => ({
    id: d.id as string,
    path: d.path as string,
    title: (d.title as string | null) ?? null,
    status: d.status as DocumentStatus,
    errorMessage: (d.errorMessage as string | null) ?? null,
    transcriptionJob: (d.transcriptionJob as { status: TranscriptionJobStatus } | null) ?? null,
  })) as ChapterDocumentInput[];

  const course = projectCourseLifecycleState(docs);
  assert.equal(course.total, docs.length);
  assert.equal(course.readyCount + course.runningCount + course.queuedCount + course.failedCount, course.total);
  assert.deepEqual(
    { ready: course.readyCount, running: course.runningCount, failed: course.failedCount, queued: course.queuedCount },
    { ready: 1, running: 1, failed: 1, queued: 1 },
  );

  const dockFacts = projectDockTutorialFacts(docs);
  assert.equal(dockFacts.totalChapters, docs.length);
  assert.equal(dockFacts.activeDocPath, 'docs/engine.md');
  assert.equal(typeof ingest.publishRequested, 'boolean');
  assert.ok(['number', 'object', 'undefined'].includes(typeof ingest.avgJobSeconds));

  const versions = readContract<{ ok: boolean; versions: Array<Record<string, unknown>> }>('chapter-versions-list.response.json');
  assert.equal(versions.ok, true);
  assert.ok(Array.isArray(versions.versions));
  let withContentCount = 0;
  let withoutContentCount = 0;
  const versionShapes = versions.versions.map((v) => {
    for (const k of ['id', 'authorId', 'visibility', 'source', 'createdAt']) {
      assert.equal(typeof v[k], 'string', `version.${k}`);
    }
    assert.equal(typeof v.voteCount, 'number');
    assert.equal(typeof v.isCanonical, 'boolean');
    assert.equal(typeof v.hasVoted, 'boolean');
    assert.equal(typeof v.isContentValid, 'boolean');
    assert.ok(['string', 'object'].includes(typeof v.contentId));
    assert.ok(v.author && ['string', 'object'].includes(typeof (v.author as Record<string, unknown>).name));
    assert.ok(['PUBLIC', 'PRIVATE'].includes(String(v.visibility)));
    assert.ok(['RELAY', 'RETRANSLATE'].includes(String(v.source)));
    if (v.content !== undefined) {
      assert.equal(typeof v.content, 'string');
      assert.equal(v.isContentValid, true);
      withContentCount++;
    } else {
      withoutContentCount++;
    }
    return {
      id: v.id,
      visibility: v.visibility,
      source: v.source,
      isCanonical: v.isCanonical,
      isContentValid: v.isContentValid,
      hasInlineContent: v.content !== undefined,
    };
  });
  assert.ok(withContentCount > 0 && withoutContentCount > 0);

  const progress = readContract<{
    ok: boolean;
    chapterScores: Record<string, number>;
    overallProgress: number;
    viewedCount: number;
    lastReadPath?: string;
    lastReadAt?: string;
  }>('reading-progress-sync.response.json');
  assert.equal(progress.ok, true);
  for (const score of Object.values(progress.chapterScores)) {
    assert.equal(typeof score, 'number');
    assert.ok(score >= 0 && score <= 100);
  }
  assert.equal(typeof progress.overallProgress, 'number');
  assert.equal(typeof progress.viewedCount, 'number');

  const patch = readContract<Record<string, unknown>>('repos-patch.request.json');
  assert.equal(patch.isPublic, true);
  assert.equal(patch.reviewStatus, 'APPROVED');
  assert.equal(patch.touchPublishedAt, true);
  assert.equal(patch.touchReviewedAt, true);
  assert.equal(patch.clearRejectionReason, true);
  assert.equal(patch.relayEnabled, true);
  assert.equal(patch.touchRelayNotifiedAt, true);
  assert.equal(patch.gitSha, 'abc123');
  assert.equal(patch.hasUpstreamUpdate, false);
  assert.ok(patch.upstreamEtag);
  assert.equal(patch.touchUpstreamCheckedAt, true);

  return {
    goldenDir,
    courseProjection: course,
    dockFacts,
    versionShapes,
    readingProgress: {
      chapterScores: progress.chapterScores,
      overallProgress: progress.overallProgress,
      viewedCount: progress.viewedCount,
    },
    patchRequestKeys: Object.keys(patch).sort(),
  };
}

function runCodeWrapParity(fixturePath: string) {
  const fixture = readRepoJson<{
    cases: Array<{ name: string; filePath: string; raw: string; expected: string }>;
  }>(fixturePath);
  assert.ok(fixture.cases.length > 0, `${fixturePath} must not be empty`);

  const cases = fixture.cases.map((tc) => {
    const got = wrapCodeAsMdx(tc.filePath, tc.raw);
    assert.equal(got, tc.expected, `code-wrap: ${tc.name}`);
    return { name: tc.name, got };
  });

  return { fixturePath, cases };
}

export async function run(input: string): Promise<string> {
  const payload = JSON.parse(input) as { op: string } & Record<string, unknown>;
  let result: unknown;
  switch (payload.op) {
    case 'billing':
      result = runBillingParity(String(payload.fixturePath));
      break;
    case 'mdx-fingerprint':
      result = runMdxFingerprintParity(String(payload.fixturePath));
      break;
    case 'golden-parity':
      result = runGoldenParity(payload.fixtures as Record<string, string>);
      break;
    case 'credits-parity-and-sync':
      result = runCreditsParityAndSync(payload.paths as { settleGo: string; prismaSchema: string; creditsSqlGo: string });
      break;
    case 'sidecar-contract':
      result = runSidecarContract(String(payload.goldenDir));
      break;
    case 'code-wrap':
      result = runCodeWrapParity(String(payload.fixturePath));
      break;
    default:
      throw new Error(`Unknown cross-lang-parity op: ${payload.op}`);
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}
