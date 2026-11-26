import { z } from 'zod';
import { tool } from 'ai';
import { searchRepositoryDocs } from '@/lib/mcp/doc-search';
import { formatHighDensityDocContext } from './context-formatter';
import { prisma } from '@/lib/db';
import { TELEMETRY_EVENTS } from '@/lib/telemetry/beacon';

export interface AgentContext {
  userId: string;
  sessionId: string;
  owner: string;
  repo: string;
  currentPath: string;
  repositoryId: string;
}

export const createAgentTools = (context: AgentContext) => ({
  search_knowledge_base: tool({
    description: "Search the tutorial documentation and the user's past memories to find answers to technical questions. Always use this tool if the user asks a technical question about the documentation or project that you cannot answer from conversation history alone.",
    inputSchema: z.object({
      query: z.string().optional().describe('The specific technical question or topic to search for.'),
    }),
    execute: async ({ query }: { query?: string }) => {
      const safeQuery = query && query.trim().length > 0 ? query : 'Core concepts and introduction';
      console.log(`[Tool] search_knowledge_base invoked for query: ${safeQuery}`);
      try {
        const docs = await searchRepositoryDocs(context.repositoryId, safeQuery, 5, undefined, undefined, undefined, undefined, undefined, context.userId);
        const contextStr = formatHighDensityDocContext(docs, {
          owner: context.owner,
          repo: context.repo,
          totalTokenBudget: 2000,
        });
        return { status: 'success', context: contextStr || 'No relevant tutorial documentation found.' };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Tool Error] search_knowledge_base:', err);
        return { status: 'error', message };
      }
    },
  }),

  update_world_state: tool({
    description: "Update the user's cognitive learning state when they learn new concepts, finish tasks, or change learning goals.",
    inputSchema: z.object({
      learning_goal: z.string().optional().describe('The overall learning goal or objective the user is trying to achieve.'),
      mastered_concepts: z.array(z.string()).optional().describe('Concepts the user just successfully applied or understood.'),
      active_tasks: z.array(z.string()).optional().describe('New tasks the user is working on.'),
      frustration_level: z.number().min(0).max(10).optional().describe('Rate the user frustration from 0 (happy) to 10 (angry/blocked).'),
    }),
    execute: async (patch: {
      learning_goal?: string;
      mastered_concepts?: string[];
      active_tasks?: string[];
      frustration_level?: number;
    }) => {
      return { status: 'success', update: patch };
    },
  }),

  get_user_learning_journey: tool({
    description: "Retrieve the user's recent learning behavior, such as which pages they focused on, what they skipped, and any frustration signals (e.g., rage clicks). Use this to understand the user's context before explaining a concept.",
    inputSchema: z.object({
      limit: z.number().optional().describe('Number of recent events to retrieve, default is 20.'),
    }),
    execute: async ({ limit = 20 }: { limit?: number }) => {
      console.log(`[Tool] get_user_learning_journey invoked for user: ${context.userId}`);
      try {
        const events = await prisma.episodicEvent.findMany({
          where: {
            userId: context.userId,
            OR: [
              { pageUrl: `/docs/${context.owner}/${context.repo}` },
              { pageUrl: { startsWith: `/docs/${context.owner}/${context.repo}/` } },
              { pageUrl: { startsWith: `/docs/${context.owner}/${context.repo}?` } },
              { pageUrl: { startsWith: `/docs/${context.owner}/${context.repo}#` } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });

        const timeGroup = await prisma.episodicEvent.groupBy({
          by: ['pageUrl'],
          where: {
            userId: context.userId,
            eventType: { in: [TELEMETRY_EVENTS.SECTION_FOCUS, TELEMETRY_EVENTS.PAGE_VIEW] },
            OR: [
              { pageUrl: `/docs/${context.owner}/${context.repo}` },
              { pageUrl: { startsWith: `/docs/${context.owner}/${context.repo}/` } },
              { pageUrl: { startsWith: `/docs/${context.owner}/${context.repo}?` } },
              { pageUrl: { startsWith: `/docs/${context.owner}/${context.repo}#` } },
            ],
          },
          _sum: { duration: true },
          orderBy: { _sum: { duration: 'desc' } },
          take: limit || 20,
        });

        const timeSpentOnPages: Record<string, number> = {};
        timeGroup.forEach((g) => {
          timeSpentOnPages[g.pageUrl] = g._sum.duration || 0;
        });

        const skipped: string[] = [];
        const frustrations: string[] = [];
        const highlights: string[] = [];
        const quizzes: string[] = [];

        events.forEach((e) => {
          const meta = (e.metadata && typeof e.metadata === 'object' ? e.metadata : {}) as Record<string, unknown>;
          if (e.eventType === TELEMETRY_EVENTS.CONTENT_SKIP) skipped.push(`Skipped section on ${e.pageUrl}`);
          if (e.eventType === TELEMETRY_EVENTS.RAGE_CLICK) frustrations.push(`Rage clicked on ${e.pageUrl} at ${e.targetId}`);
          if (e.eventType === TELEMETRY_EVENTS.TEXT_HIGHLIGHT) highlights.push(`Highlighted on ${e.pageUrl}: "${meta.textSnippet || meta.text || ''}"`);
          if (e.eventType === TELEMETRY_EVENTS.QUIZ_INTERACTION) quizzes.push(`Quiz on ${e.pageUrl}: Question "${meta.question || ''}" - Answered "${meta.answer || meta.selected || ''}" (${meta.isCorrect ? 'Correct' : 'Incorrect'})`);
        });

        return {
          status: 'success',
          summary: {
            timeSpentOnPages,
            skipped,
            frustrations,
            highlights,
            quizzes,
          },
          rawEvents: events.map((e) => ({ type: e.eventType, target: e.targetId, duration: e.duration, url: e.pageUrl })),
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Tool Error] get_user_learning_journey:', err);
        return { status: 'error', message };
      }
    },
  }),
});
