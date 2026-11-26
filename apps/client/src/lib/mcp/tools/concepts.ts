import { prisma } from '@/lib/db';
import { ignoreBestEffort } from '@/lib/best-effort';
import { buildCleanSectionAddress } from '@/lib/mcp/section-address';
import {
  resolveConceptNode,
  getConceptNeighbors,
  getLearningPathConcepts,
  getConceptCodeContext,
  getConceptGrounding,
  formatLearningPathOutput,
  formatNeighborsOutput,
  getConceptDependencies,
  formatDependencyHintText,
  neighborRelationTag,
} from '@/lib/mcp/concept-graph';
import { isCodeChapterPath } from '@/engine/update-candidate-set';
import { formatCourseMap } from '@/lib/mcp/course-map';
import { resolveEffectiveNavTree } from '@/lib/mcp/outline-projector';
import { isWebDocRepository, resolveDocLiveUrl } from '@/lib/repository-resolver';
import {
  RepoRuntime,
  resolveScopedTarget,
  refNotFoundError,
  scopeRequiredError,
  renderMacroArchitecture,
  renderSubsystemArchitecture,
  fallbackWarning,
} from './shared';

export function parseScopedConcept(raw: string): { scope: string; conceptName: string } {
  const trimmed = (raw || '').trim();
  const idx = trimmed.lastIndexOf('#');
  if (idx >= 0) {
    return {
      scope: trimmed.slice(0, idx).trim(),
      conceptName: trimmed.slice(idx + 1).trim(),
    };
  }
  return { scope: '', conceptName: trimmed };
}

interface ConceptDetailsArgs {
  repository?: string;
  concept: string;
}

async function runGetConceptDetails(args: ConceptDetailsArgs, runtime: RepoRuntime, telemetryRepositoryId?: string) {
  const parsed = parseScopedConcept(args.concept || '');
  const repoTarget = args.repository || (parsed.scope || undefined);
  const ctx = await resolveScopedTarget(runtime, repoTarget);
  if (!ctx) {
    return repoTarget ? refNotFoundError(repoTarget, runtime) : scopeRequiredError(runtime);
  }
  const startTime = Date.now();
  const concept = (parsed.conceptName || args.concept || '').trim();

  if (!concept) {
    return {
      content: [{ type: 'text' as const, text: `Error: "concept" is required. Pass a concept name or slug (see outline, Knowledge Graph Concepts section).` }],
      isError: true,
    };
  }

  // Use resolveConceptNode so get_concept_details matches concept_neighbors and avoids broad contains ambiguity.
  const conceptNode = await resolveConceptNode(ctx.repository.id, concept);

  if (!conceptNode) {
    return {
      telemetry: { dimension: 'all', query: concept, resultCount: 0, resultSnapshot: { count: 0, concept } },
      content: [{
        type: 'text' as const,
        text: `Error: Concept "${concept}" not found in ${ctx.owner}/${ctx.repo}. Use outline (see Knowledge Graph Concepts section) to see available concepts, or search to locate related content.`,
      }],
      isError: true,
    };
  }

  const docPath = conceptNode.document?.path;
  let outputText = `${fallbackWarning(ctx)}🧠 概念详情 (Concept Details): ${conceptNode.conceptName} (${conceptNode.category})\n`;
  if (docPath) {
    outputText += `- 来源: ${docPath}`;
    if (conceptNode.headingPath) {
      outputText += ` [Address: ${buildCleanSectionAddress(docPath, conceptNode.headingPath)}]`;
    }
    outputText += `\n`;

    if (isCodeChapterPath(docPath)) {
      const codeCtx = await getConceptCodeContext(ctx.repository.id, docPath);
      if (codeCtx) {
        outputText += formatCodeContext(codeCtx);
      }
    }

    if (isWebDocRepository(ctx.repository)) {
      const profile = (ctx.repository.repoProfile && typeof ctx.repository.repoProfile === 'object' ? ctx.repository.repoProfile : {}) as Record<string, unknown>;
      const liveUrl = resolveDocLiveUrl(ctx.repository.navTree, docPath, (profile.originalUrl as string) || null);
      if (liveUrl) {
        outputText += `- 原站链接 (Live URL): ${liveUrl}\n`;
      }
    }
  }

  const grounding = await getConceptGrounding(ctx.repository.id, conceptNode.conceptName, docPath).catch(() => { ignoreBestEffort(); return null; });
  if (grounding) {
    if (grounding.goldenSymbols.length > 0) {
      outputText += `- 核心代码符号 (AST Golden Symbols):\n`;
      for (const sym of grounding.goldenSymbols.slice(0, 4)) {
        outputText += `  - \`${sym.name}\` (${sym.kind}) in \`${sym.file}\`\n`;
      }
    }
    if (grounding.backboneFiles.length > 0) {
      outputText += `- 主干实现文件 (Backbone Files):\n`;
      for (const f of grounding.backboneFiles.slice(0, 3)) {
        outputText += `  - \`${f.path}\` (${f.role})\n`;
      }
    }
  }
  if (conceptNode.summary) {
    outputText += `- 设计摘要: ${conceptNode.summary}\n`;
  }
  if (conceptNode.canonicalKey) {
    const memberCount = await prisma.tutorialConceptNode
      .count({ where: { repositoryId: ctx.repository.id, canonicalKey: conceptNode.canonicalKey } })
      .catch(() => { ignoreBestEffort(); return 1; });
    const repName = conceptNode.canonicalName || conceptNode.conceptName;
    if (memberCount > 1 || repName !== conceptNode.conceptName) {
      outputText += `- 归并: ${repName} · 同义 ${memberCount} 处\n`;
    }
  }
  if (conceptNode.principlesText) {
    outputText += `- 核心原理 (Principles):\n  ${conceptNode.principlesText.replace(/\n/g, '\n  ')}\n`;
  }
  if (conceptNode.authorReflections) {
    outputText += `- 作者思考与 Trade-off 权衡:\n  > ${conceptNode.authorReflections.replace(/\n/g, '\n  > ')}\n`;
  }
  if (conceptNode.sopSteps && conceptNode.sopSteps.length > 0) {
    outputText += `- 核心 SOP 开发步骤:\n`;
    conceptNode.sopSteps.forEach((step, idx) => {
      outputText += `  ${idx + 1}. ${step}\n`;
    });
  }
  if (conceptNode.subTopics && conceptNode.subTopics.length > 0) {
    outputText += `- 关联主题 (Sub Topics): ${conceptNode.subTopics.join('、')}\n`;
  }
  if (conceptNode.tags && conceptNode.tags.length > 0) {
    outputText += `- 标签 (Tags): ${conceptNode.tags.join('、')}\n`;
  }
  if (docPath && conceptNode.headingPath) {
    outputText += `\n(Use read with "target" set to the Address above to read the source section in full.)`;
  }

  const deps = await getConceptDependencies(ctx.repository.id, conceptNode.id);
  if (deps.length > 0) {
    outputText += formatDependencyHintText(conceptNode.conceptName, deps);
  }
  const neighbors = await getConceptNeighbors(ctx.repository.id, conceptNode.id);
  if (neighbors.length > 0) {
    outputText += `\n\n🧭 直接邻居 (Neighbors): `;
    outputText += neighbors
      .slice(0, 6)
      .map((n) => `${neighborRelationTag(n.relation)}${n.conceptName}`)
      .join('、');
    outputText += `\n(用 explore_concept(action='neighbors') 查看全部邻居及 Address，explore_concept(action='path') 获取完整递进链)`;
  }

return {
      telemetry: { dimension: 'all', query: concept, resultCount: 1, resultSnapshot: { count: 1, concept: conceptNode.conceptName, category: conceptNode.category, docPath } },
    content: [{ type: 'text' as const, text: outputText }],
  };
}

async function runConceptNeighbors(args: { repository?: string; concept: string }, runtime: RepoRuntime, telemetryRepositoryId?: string) {
  const parsed = parseScopedConcept(args.concept || '');
  const repoTarget = args.repository || (parsed.scope || undefined);
  const ctx = await resolveScopedTarget(runtime, repoTarget);
  if (!ctx) {
    return repoTarget ? refNotFoundError(repoTarget, runtime) : scopeRequiredError(runtime);
  }
  const startTime = Date.now();
  const concept = (parsed.conceptName || args.concept || '').trim();

  if (!concept) {
    return {
      content: [{ type: 'text' as const, text: `Error: "concept" is required. Pass a concept name or slug (see outline, Knowledge Graph Concepts section).` }],
      isError: true,
    };
  }

  const node = await resolveConceptNode(ctx.repository.id, concept);
  if (!node) {
    return {
      telemetry: { dimension: 'all', query: concept, resultCount: 0, resultSnapshot: { count: 0, concept } },
      content: [{
        type: 'text' as const,
        text: `Error: Concept "${concept}" not found in ${ctx.owner}/${ctx.repo}. Use outline (see Knowledge Graph Concepts section) to see available concepts, or search to locate related content.`,
      }],
      isError: true,
    };
  }

  const neighbors = await getConceptNeighbors(ctx.repository.id, node.id);

return {
      telemetry: { dimension: 'all', query: concept, resultCount: neighbors.length, resultSnapshot: { count: neighbors.length, items: neighbors.slice(0, 5).map(n => ({ conceptName: n.conceptName, type: n.relation.type })) } },
    content: [{ type: 'text' as const, text: formatNeighborsOutput(node.conceptName, neighbors) }],
  };
}

async function runLearningPath(args: { repository?: string; concept: string }, runtime: RepoRuntime, telemetryRepositoryId?: string) {
  const parsed = parseScopedConcept(args.concept || '');
  const repoTarget = args.repository || (parsed.scope || undefined);
  const ctx = await resolveScopedTarget(runtime, repoTarget);
  if (!ctx) {
    return repoTarget ? refNotFoundError(repoTarget, runtime) : scopeRequiredError(runtime);
  }
  const startTime = Date.now();
  const concept = (parsed.conceptName || args.concept || '').trim();

  if (!concept) {
    return {
      content: [{ type: 'text' as const, text: `Error: "concept" is required. Pass a target concept name or slug (see outline, Knowledge Graph Concepts section).` }],
      isError: true,
    };
  }

  const node = await resolveConceptNode(ctx.repository.id, concept);
  if (!node) {
    return {
      telemetry: { dimension: 'all', query: concept, resultCount: 0, resultSnapshot: { count: 0, concept } },
      content: [{
        type: 'text' as const,
        text: `Error: Concept "${concept}" not found in ${ctx.owner}/${ctx.repo}. Use outline (see Knowledge Graph Concepts section) to see available concepts.`,
      }],
      isError: true,
    };
  }

  const chain = await getLearningPathConcepts(ctx.repository.id, node.id);

  const outputText = formatLearningPathOutput(node.conceptName, chain);

return {
      telemetry: { dimension: 'all', query: concept, resultCount: chain.length, resultSnapshot: { count: chain.length, items: chain.slice(0, 5).map(c => ({ conceptName: c.conceptName, depth: c.depth })) } },
    content: [{ type: 'text' as const, text: outputText }],
  };
}

async function runCourseMap(args: { repository?: string }, runtime: RepoRuntime, telemetryRepositoryId?: string) {
  const ctx = await resolveScopedTarget(runtime, args.repository);
  if (!ctx) {
    return args.repository ? refNotFoundError(args.repository, runtime) : scopeRequiredError(runtime);
  }
  const startTime = Date.now();
  const repo = await prisma.repository.findUnique({
    where: { id: ctx.repository.id },
    select: { id: true, repoProfile: true, navTree: true },
  });
  const effectiveNavTree = await resolveEffectiveNavTree(ctx.repository.id, {
    owner: ctx.repository.owner,
    repo: ctx.repository.repo,
    fallbackNavTree: repo?.navTree,
  });
  const text = formatCourseMap(repo?.repoProfile, (effectiveNavTree as any) || null);

return {
      telemetry: { dimension: 'all', resultCount: 1, resultSnapshot: { hasClusters: !!(repo?.repoProfile as any)?.codeClusters } }, content: [{ type: 'text' as const, text }] };
}

async function runConceptArchitecture(
  args: { repository?: string; concept?: string },
  runtime: RepoRuntime,
  telemetryId?: string
) {
  const parsed = parseScopedConcept(args.concept || '');
  const repoTarget = args.repository || (parsed.scope || undefined);
  const ctx = await resolveScopedTarget(runtime, repoTarget);
  if (!ctx) {
    return repoTarget ? refNotFoundError(repoTarget, runtime) : scopeRequiredError(runtime);
  }
  const startTime = Date.now();
  const rawConcept = (parsed.conceptName || args.concept || '').trim();
  const conceptLower = rawConcept.toLowerCase();

  let outputText = '';
  if (!conceptLower || conceptLower === 'all' || conceptLower === 'root' || conceptLower === 'system') {
    outputText = renderMacroArchitecture(ctx.owner, ctx.repo, ctx.repository.repoProfile);
  } else {
    outputText = renderSubsystemArchitecture(ctx.owner, ctx.repo, ctx.repository.repoProfile, rawConcept);
  }

return {
      telemetry: { dimension: 'architecture', query: rawConcept, resultCount: 1, resultSnapshot: { concept: rawConcept } },
    content: [
      {
        type: 'text' as const,
        text: outputText,
      },
    ],
  };
}

export async function runExploreConcept(
  args: { repository?: string; concept?: string; action?: 'details' | 'neighbors' | 'path' | 'course_map' | 'coverage' | 'recommend' | 'architecture' | 'quiz' | 'editions' },
  runtime: RepoRuntime,
  telemetryId?: string
) {
  const parsed = parseScopedConcept(args.concept || '');
  const effectiveRepository = args.repository || (parsed.scope || undefined);
  const effectiveConcept = parsed.conceptName || (args.concept || '').trim();

  const action = args.action || 'details';
  if (action === 'architecture') {
    return runConceptArchitecture({ repository: effectiveRepository, concept: effectiveConcept }, runtime, telemetryId);
  }
  if (action === 'quiz') {
    return runConceptQuiz({ repository: effectiveRepository, concept: effectiveConcept }, runtime, telemetryId);
  }
  if (action === 'editions') {
    return runConceptEditions({ repository: effectiveRepository, concept: effectiveConcept }, runtime, telemetryId);
  }
  if (action === 'course_map') {
    return runCourseMap({ repository: effectiveRepository }, runtime, telemetryId);
  }
  if (action === 'coverage') {
    if (runtime.multiRepo && runtime.userId) {
      const { findSkillCoverageAcrossBookshelf, formatSkillCoverage } = await import('@/lib/mcp/cross-repo-tools');
      const hits = await findSkillCoverageAcrossBookshelf(runtime.userId, effectiveConcept);
      return { content: [{ type: 'text' as const, text: formatSkillCoverage(effectiveConcept, hits) }] };
    }
    return { content: [{ type: 'text' as const, text: 'Skill coverage analysis is available on Hub mode.' }] };
  }
  if (action === 'recommend') {
    const description = (args.concept || '').trim();
    if (!description) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Error: pass a short project description as "concept" for recommendation (e.g. "Next.js 15 + Drizzle + auth 全栈项目").',
          },
        ],
        isError: true,
      };
    }
    if (runtime.multiRepo && runtime.userId) {
      const startTime = Date.now();
      const { recommendTutorials, formatRecommendTutorial } = await import('@/lib/mcp/cross-repo-tools');
      const ranked = await recommendTutorials(runtime.userId, description);
      
      return {
      telemetry: { dimension: 'all', query: description.slice(0, 200), resultCount: ranked.length, resultSnapshot: { count: ranked.length, items: ranked.slice(0, 5).map((r) => ({ repo: `${r.repo.owner}/${r.repo.repo}`, score: r.score })) } }, content: [{ type: 'text' as const, text: formatRecommendTutorial(description, ranked) }] };
    }
    return { content: [{ type: 'text' as const, text: 'Tutorial recommendation is available on Hub mode (omit "repository" to rank your whole bookshelf).' }] };
  }
  if (!effectiveConcept) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Error: "concept" parameter is required for details, neighbors, or learning path exploration.',
        },
      ],
      isError: true,
    };
  }
  if (action === 'neighbors') {
    return runConceptNeighbors({ repository: effectiveRepository, concept: effectiveConcept }, runtime, telemetryId);
  }
  if (action === 'path') {
    return runLearningPath({ repository: effectiveRepository, concept: effectiveConcept }, runtime, telemetryId);
  }
  return runGetConceptDetails({ repository: effectiveRepository, concept: effectiveConcept }, runtime, telemetryId);
}

function formatCodeContext(codeCtx: { title: string; directories: string[]; files: string[] }): string {
  let text = `- 所属模块: ${codeCtx.title}`;
  if (codeCtx.directories.length > 0) {
    text += ` (${codeCtx.directories.join(', ')})`;
  }
  text += `\n`;
  if (codeCtx.files.length > 0) {
    const shown = codeCtx.files.slice(0, 8);
    text += `- 关联源码 (Code Files, ${codeCtx.files.length}): ${shown.join(', ')}${codeCtx.files.length > shown.length ? ' …' : ''}\n`;
  }
  return text;
}

async function runConceptQuiz(
  args: { repository?: string; concept?: string },
  runtime: RepoRuntime,
  telemetryId?: string
) {
  const { resolveScopedTarget, refNotFoundError, scopeRequiredError } = await import('./shared');
  const ctx = await resolveScopedTarget(runtime, args.repository);
  if (!ctx) {
    return args.repository ? refNotFoundError(args.repository, runtime) : scopeRequiredError(runtime);
  }
  const startTime = Date.now();
  const { resolveConceptNode } = await import('@/lib/mcp/concept-graph');
  const node = await resolveConceptNode(ctx.repository.id, (args.concept || '').trim());
  if (!node?.documentId) {
    return {
      telemetry: { dimension: 'documents', query: args.concept, resultCount: 0 },
      content: [{ type: 'text' as const, text: `Concept "${args.concept}" not found; pass a concept name from outline.` }],
      isError: true,
    };
  }

  const quizzes = await prisma.chapterQuiz
    .findMany({ where: { documentId: node.documentId }, orderBy: { order: 'asc' }, take: 20 })
    .catch(() => { ignoreBestEffort(); return []; });

  const lines: string[] = [`# 📝 Chapter Quizzes for concept "${args.concept}"`, ''];
  if (quizzes.length === 0) {
    lines.push('No structured quizzes persisted for this chapter (older transcriptions keep quizzes folded inside concept reflections; re-transcription will persist them structurally).');
  } else {
    for (const q of quizzes) {
      lines.push(`### Q${q.order + 1}: ${q.question}`);
      q.options.forEach((opt, i) => lines.push(`- ${String.fromCharCode(65 + i)}. ${opt}`));
      if (q.explanation) lines.push('', `Explanation: ${q.explanation}`);
      lines.push('', `(Answer: ${String.fromCharCode(65 + q.correctIndex)})`, '');
    }
    lines.push('(Answers are for self-check; use read with the chapter path for full context.)');
  }

return {
      telemetry: { dimension: 'documents', query: args.concept, resultCount: quizzes.length }, content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

async function runConceptEditions(
  args: { repository?: string; concept?: string },
  runtime: RepoRuntime,
  telemetryId?: string
) {
  const { resolveScopedTarget, refNotFoundError, scopeRequiredError } = await import('./shared');
  const ctx = await resolveScopedTarget(runtime, args.repository);
  if (!ctx) {
    return args.repository ? refNotFoundError(args.repository, runtime) : scopeRequiredError(runtime);
  }
  const startTime = Date.now();
  const conceptName = (args.concept || '').trim();
  if (!conceptName) {
    return {
      content: [{ type: 'text' as const, text: 'Error: "concept" is required for cross-edition comparison.' }],
      isError: true,
    };
  }

  const rows = await prisma.repository
    .findMany({
      where: {
        owner: { equals: ctx.owner, mode: 'insensitive' },
        repo: { equals: ctx.repo, mode: 'insensitive' },
        isPublic: true,
      },
      select: {
        id: true,
        edition: true,
        conceptNodes: {
          where: {
            OR: [
              { conceptName: { equals: conceptName, mode: 'insensitive' } },
              { slug: conceptName.toLowerCase() },
            ],
          },
          select: { conceptName: true, principlesText: true, summary: true },
          take: 1,
        },
      },
      orderBy: { edition: 'asc' },
    })
    .catch(() => { ignoreBestEffort(); return []; });

  const editionsWithConcept = rows.filter((r) => r.conceptNodes.length > 0);
  const lines: string[] = [`# 🔄 Cross-Edition Comparison: "${conceptName}" in ${ctx.owner}/${ctx.repo}`, ''];

  if (editionsWithConcept.length <= 1) {
    lines.push(
      editionsWithConcept.length === 1
        ? 'This concept exists in only ONE edition row — no cross-edition divergence to compare.'
        : 'This concept was not found in any edition row (check the concept name via explore_concept action="details").'
    );
  } else {
    lines.push(`Editions found: ${editionsWithConcept.length}`, '');
    const base = editionsWithConcept[0].conceptNodes[0];
    for (const row of editionsWithConcept) {
      const node = row.conceptNodes[0];
      const label = row.edition && row.edition !== '' ? row.edition : '(base)';
      lines.push(`## Edition: ${label}`);
      if (node.principlesText && node.principlesText !== base.principlesText) {
        lines.push(`- **Principles (differs from ${editionsWithConcept[0].edition || '(base)'})**: ${node.principlesText.slice(0, 400)}`);
      } else {
        lines.push('- Principles: (same as base edition)');
      }
      if (node.summary && node.summary !== base.summary) {
        lines.push(`- **Summary (differs)**: ${node.summary.slice(0, 300)}`);
      } else {
        lines.push('- Summary: (same as base edition)');
      }
      lines.push('');
    }
    lines.push('(Diff lines are truncated to 400/300 chars; use explore_concept action="details" with "owner/repo@edition" for the full package of a specific edition.)');
  }

return {
      telemetry: { dimension: 'documents', query: conceptName, resultCount: editionsWithConcept.length }, content: [{ type: 'text' as const, text: lines.join('\n') }] };
}
