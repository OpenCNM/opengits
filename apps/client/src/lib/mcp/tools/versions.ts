import { prisma } from '@/lib/db';
import {
  RepoRuntime,
  resolveScopedTarget,
  refNotFoundError,
  scopeRequiredError,
} from './shared';

export interface ListChapterVersionsArgs {
  repository?: string;
  path?: string;
}

export async function runListChapterVersions(
  args: ListChapterVersionsArgs,
  runtime: RepoRuntime,
  telemetryRepositoryId?: string
) {
  const startTime = Date.now();
  const ctx = await resolveScopedTarget(runtime, args.repository);
  if (!ctx) {
    return args.repository ? refNotFoundError(args.repository, runtime) : scopeRequiredError(runtime);
  }

  const rawPath = (args.path || '').trim();
  if (!rawPath) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Error: "path" is required. Pass a chapter document path (e.g. "ch01-intro.md"; see outline for valid paths).',
        },
      ],
      isError: true,
    };
  }

  // Shared rows only; public version views must not expose private user drafts.
  const doc = await prisma.document
    .findFirst({
      where: {
        repositoryId: ctx.repository.id,
        ownerUserId: null,
        status: 'PROCESSED',
        OR: [
          { path: { equals: rawPath, mode: 'insensitive' } },
          { path: { equals: `${rawPath}.md`, mode: 'insensitive' } },
          { path: { equals: `${rawPath}.mdx`, mode: 'insensitive' } },
        ],
      },
      select: { id: true, path: true, title: true, contentId: true },
    })
    .catch(() => null);

  if (!doc) {
    return {
      telemetry: { dimension: 'documents', query: rawPath, resultCount: 0 },
      content: [
        {
          type: 'text' as const,
          text: `Error: Document "${rawPath}" not found in ${ctx.owner}/${ctx.repo}. Call outline to view valid document paths.`,
        },
      ],
      isError: true,
    };
  }

  const versions = await prisma.chapterVersion
    .findMany({
      where: { documentId: doc.id, visibility: 'PUBLIC' },
      select: {
        id: true,
        source: true,
        voteCount: true,
        isCanonical: true,
        pinnedAt: true,
        createdAt: true,
        contentId: true,
        author: { select: { name: true } },
      },
      orderBy: [{ pinnedAt: 'desc' }, { voteCount: 'desc' }, { createdAt: 'desc' }],
      take: 20,
    })
    .catch(() => []);

  const lines: string[] = [];
  lines.push(`# 📚 Chapter Versions: \`${doc.path}\` in ${ctx.owner}/${ctx.repo}`);
  lines.push(`- **Current Effective**: content ${doc.contentId ? `\`${doc.contentId.slice(0, 12)}…\`` : '(legacy inline)'}`);
  if (versions.length === 0) {
    lines.push('\nNo community chapter versions (relay/retranslation) exist for this chapter yet — the current transcription is the only version.');
    
    return {
      telemetry: { dimension: 'documents', query: rawPath, resultCount: 0 }, content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }

  lines.push(`- **Community Versions**: ${versions.length}`);
  lines.push('');
  for (const v of versions) {
    const effective = v.contentId === doc.contentId ? ' · **[CURRENT]**' : '';
    const pin = v.pinnedAt ? ' · 📌 author-pinned' : '';
    const canonical = v.isCanonical ? ' · canonical' : '';
    lines.push(
      `- \`${v.id.slice(0, 12)}…\` [${v.source}] by ${v.author?.name || 'anonymous'} · votes: ${v.voteCount}${pin}${canonical}${effective}`
    );
  }
  lines.push(
    '\n(Use read with this document path to get the currently effective chapter content; version market data is observational.)'
  );

return {
      telemetry: { dimension: 'documents', query: rawPath, resultCount: versions.length }, content: [{ type: 'text' as const, text: lines.join('\n') }] };
}
