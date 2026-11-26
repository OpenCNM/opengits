import { RepoRuntime, fallbackWarning } from './shared';

export async function runListResources(args: { category?: string; query?: string }, runtime: RepoRuntime) {
  if (runtime.multiRepo && runtime.userId) {
    const { buildBookshelfManifest } = await import('@/lib/mcp/capability-manifest');
    const manifests = await buildBookshelfManifest(runtime.userId);
    let filtered = manifests;
    if (args.category) {
      const catLower = args.category.toLowerCase();
      filtered = filtered.filter((m) => (m.identity.category || '').toLowerCase().includes(catLower));
    }
    if (args.query) {
      const qLower = args.query.toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.identity.displayName.toLowerCase().includes(qLower) ||
          m.identity.tags.some((t) => t.toLowerCase().includes(qLower)) ||
          m.bestUsedFor.some((b) => b.toLowerCase().includes(qLower))
      );
    }
    let text = `OpenGits Hub Bookshelf (${filtered.length} tutorials found):\n\n`;
    for (const m of filtered) {
      const isWeb = m.identity.sourceType === 'web';
      text += `### ${isWeb ? '🌐' : '🐙'} ${m.identity.displayName} [${isWeb ? 'Web Docs' : 'GitHub'}]\n`;
      text += `- Repository: \`${m.identity.id}\` | Category: ${m.identity.category || 'General'}\n`;
      text += `- Source: ${m.identity.sourceUrl} | Last Synced: ${m.identity.lastSyncedAt}\n`;
      if (m.techStack) {
        text += `- Tech Stack: ${m.techStack.primaryLanguages.join(', ')} (${m.techStack.framework || 'No framework'})\n`;
      }
      if (m.bestUsedFor?.length > 0) {
        text += `- Best Used For:\n`;
        for (const b of m.bestUsedFor) {
          text += `  * ${b}\n`;
        }
      }
      text += `\n`;
    }
    return { content: [{ type: 'text' as const, text }] };
  } else {
    const repoCtx = await runtime.resolveRepository();
    if (!repoCtx?.repository) {
      return { content: [{ type: 'text' as const, text: 'Repository not found.' }], isError: true };
    }
    const r = repoCtx.repository;
    let text = `${fallbackWarning(repoCtx)}Repository: ${repoCtx.owner}/${repoCtx.repo}\n`;
    text += `- Category: ${r.category || 'General'}\n`;
    text += `- Total Documents: ${r.documents.length}\n`;
    text += `- Target Version: ${repoCtx.targetVersionLabel || 'main'}\n`;
    return { content: [{ type: 'text' as const, text }] };
  }
}
