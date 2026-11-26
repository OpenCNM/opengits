import { defineRoute, ok } from '@/lib/api/server/define-route';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface TrendingCandidate {
  owner: string;
  repo: string;
  description: string;
  stars: number;
  language: string;
}

const CURATED_TRENDING_CANDIDATES: TrendingCandidate[] = [
  {
    owner: 'browser-use',
    repo: 'browser-use',
    description: 'Make websites accessible for AI agents',
    stars: 32000,
    language: 'Python',
  },
  {
    owner: 'vllm-project',
    repo: 'vllm',
    description: 'A high-throughput and memory-efficient inference and serving engine for LLMs',
    stars: 38000,
    language: 'Python',
  },
  {
    owner: 'infiniflow',
    repo: 'ragflow',
    description: 'An open-source RAG engine based on deep document understanding',
    stars: 28000,
    language: 'Python',
  },
  {
    owner: 'mem0ai',
    repo: 'mem0',
    description: 'The Memory layer for Personalized AI',
    stars: 26000,
    language: 'Python',
  },
  {
    owner: 'camel-ai',
    repo: 'camel',
    description: 'Finding the Scaling Law of Agents with communicative agent framework',
    stars: 12000,
    language: 'Python',
  },
  {
    owner: 'AgentOps-AI',
    repo: 'agentops',
    description: 'Python SDK for agent observability, monitoring, and replay',
    stars: 4500,
    language: 'Python',
  },
  {
    owner: 'astral-sh',
    repo: 'uv',
    description: 'An extremely fast Python package and project manager, written in Rust',
    stars: 44000,
    language: 'Rust',
  },
  {
    owner: 'khoj-ai',
    repo: 'khoj',
    description: 'An open-source AI second brain with deep search capabilities',
    stars: 23000,
    language: 'Python',
  },
  {
    owner: 'OpenBMB',
    repo: 'MiniCPM-V',
    description: 'A GPT-4V level multimodal LLM for single image, multi-image and video on device',
    stars: 16000,
    language: 'Python',
  },
  {
    owner: 'unclecode',
    repo: 'crawl4ai',
    description: 'Open-source LLM Friendly Web Crawler & Scraper',
    stars: 25000,
    language: 'Python',
  },
  {
    owner: 'All-Hands-AI',
    repo: 'OpenHands',
    description: 'AI-driven software development agents powered by open models',
    stars: 41000,
    language: 'Python',
  },
  {
    owner: 'ollama',
    repo: 'ollama',
    description: 'Get up and running with Llama 3.3, Mistral, Gemma 2, and other large language models',
    stars: 110000,
    language: 'Go',
  },
];

export const GET = defineRoute({
  scope: 'GET /api/repos/trending-recommendations',
  auth: 'public',
  handler: async () => {
    try {
      const existingRepos = await prisma.repository.findMany({
        where: {
          isPublic: true,
          OR: CURATED_TRENDING_CANDIDATES.map((c) => ({
            AND: [
              { owner: { equals: c.owner, mode: 'insensitive' as const } },
              { repo: { equals: c.repo, mode: 'insensitive' as const } },
            ],
          })),
        },
        select: { owner: true, repo: true },
      });

      const existingSet = new Set(
        existingRepos.map((r) => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`)
      );

      const unpioneered = CURATED_TRENDING_CANDIDATES.filter(
        (c) => !existingSet.has(`${c.owner.toLowerCase()}/${c.repo.toLowerCase()}`)
      );

      return ok({
        recommendations: unpioneered.slice(0, 4),
      });
    } catch {
      return ok({
        recommendations: CURATED_TRENDING_CANDIDATES.slice(0, 3),
      });
    }
  },
});
