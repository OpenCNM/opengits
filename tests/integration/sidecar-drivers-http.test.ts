import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { SidecarError } from '@/lib/sidecar-client';
import { encryptApiKey } from '@/lib/crypto/api-key-cipher';
import { executeSidecarAssetServe, pipeSidecarAssetResponse } from '@/engine/asset-driver';
import { computeReadingFingerprintBatchViaSidecar } from '@/engine/fingerprint-driver';
import { executeSidecarLlmsTxt } from '@/engine/llms-txt-driver';
import { executeSidecarScoutInspect } from '@/engine/scout-driver';
import {
  executeSidecarTreeOutline,
  type MacroTopology,
} from '@/engine/tree-outline-driver';
import {
  assembleEnrichedMermaid,
  enrichMacroTopologyWithLlm,
} from '@/engine/macro-topology-enricher';
import { HAS_TEST_DB, createTestUser, uniqueTestTag } from './_test-env';

/**
 * Real node:http Integration Tests for Go Sidecar & LLM Engine Drivers.
 * Zero vi.mock(), zero fetch stubbing — exercises real TCP/HTTP wire serialization,
 * streaming/SSE framing, header forwarding, error envelopes, and fail-closed/fail-open semantics.
 */

interface RecordedRequest {
  method: string;
  pathname: string;
  search: string;
  headers: http.IncomingHttpHeaders;
  bodyText: string;
  bodyJson: unknown;
}

type RouteHandler = (
  req: RecordedRequest,
  res: http.ServerResponse
) => void | Promise<void>;

const TEST_INTERNAL_TOKEN = 'it-internal-token-sidecar-http';

describe('Sidecar & LLM Engine Drivers over Real node:http', () => {
  let server: http.Server;
  let baseUrl = '';
  let routeHandler: RouteHandler = (_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unhandled route' }));
  };
  let recorded: RecordedRequest[] = [];

  const origSidecarUrlEnv = process.env.WORKER_SIDECAR_URL;
  const origInternalTokenEnv = process.env.INTERNAL_API_TOKEN;
  const origConfigEndpoint = ENGINE_CONFIG.endpoints.workerSidecar;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let bodyJson: unknown = undefined;
      if (bodyText) {
        try {
          bodyJson = JSON.parse(bodyText);
        } catch {
          bodyJson = undefined;
        }
      }
      const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const rec: RecordedRequest = {
        method: req.method || 'GET',
        pathname: parsedUrl.pathname,
        search: parsedUrl.search,
        headers: req.headers,
        bodyText,
        bodyJson,
      };
      recorded.push(rec);
      await routeHandler(rec, res);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    process.env.WORKER_SIDECAR_URL = baseUrl;
    process.env.INTERNAL_API_TOKEN = TEST_INTERNAL_TOKEN;
    (ENGINE_CONFIG.endpoints as { workerSidecar: string }).workerSidecar = baseUrl;
  });

  afterEach(() => {
    recorded = [];
    process.env.WORKER_SIDECAR_URL = baseUrl;
    process.env.INTERNAL_API_TOKEN = TEST_INTERNAL_TOKEN;
    (ENGINE_CONFIG.endpoints as { workerSidecar: string }).workerSidecar = baseUrl;
  });

  afterAll(async () => {
    if (origSidecarUrlEnv === undefined) delete process.env.WORKER_SIDECAR_URL;
    else process.env.WORKER_SIDECAR_URL = origSidecarUrlEnv;

    if (origInternalTokenEnv === undefined) delete process.env.INTERNAL_API_TOKEN;
    else process.env.INTERNAL_API_TOKEN = origInternalTokenEnv;

    (ENGINE_CONFIG.endpoints as { workerSidecar: string }).workerSidecar = origConfigEndpoint;

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('asset-driver (executeSidecarAssetServe & pipeSidecarAssetResponse)', () => {
    it('forwards query/Range headers and pipes 206 stream, 302/304 bodyless responses & 404', async () => {
      routeHandler = (req, res) => {
        if (req.search.includes('path=img%2Fhero.png')) {
          res.writeHead(206, {
            'content-type': 'image/png',
            'content-range': 'bytes 0-3/10',
            'accept-ranges': 'bytes',
            etag: '"etag-123"',
            'x-ogis-gitsha': 'abc123',
          });
          res.end(Buffer.from('PNG!'));
          return;
        }
        if (req.search.includes('path=cdn.png')) {
          res.writeHead(302, {
            location: 'https://cdn.example.com/cdn.png',
          });
          res.end('redirect-body-should-be-stripped');
          return;
        }
        if (req.search.includes('path=cached.png')) {
          res.writeHead(304, { etag: '"same"' });
          res.end();
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      };

      const res206 = await executeSidecarAssetServe({
        owner: 'octo',
        repo: 'demo',
        path: 'img/hero.png',
        sha: 'deadbeef',
        branch: 'main',
        headers: new Headers({
          range: 'bytes=0-3',
          'if-none-match': '"old"',
          'x-unrelated-header': 'ignored',
        }),
      });
      expect(res206).not.toBeNull();
      expect(res206!.status).toBe(206);
      expect(recorded[0].method).toBe('GET');
      expect(recorded[0].pathname).toBe('/v1/assets/serve');
      expect(recorded[0].headers['x-internal-token']).toBe(TEST_INTERNAL_TOKEN);
      expect(recorded[0].headers['range']).toBe('bytes=0-3');
      expect(recorded[0].headers['if-none-match']).toBe('"old"');
      expect(recorded[0].headers['x-unrelated-header']).toBeUndefined();

      const piped206 = pipeSidecarAssetResponse(res206!, { 'x-extra': 'yes' });
      expect(piped206.status).toBe(206);
      expect(piped206.headers.get('content-range')).toBe('bytes 0-3/10');
      expect(piped206.headers.get('x-content-type-options')).toBe('nosniff');
      expect(piped206.headers.get('cache-control')).toBeTruthy();
      expect(piped206.headers.get('x-extra')).toBe('yes');
      expect(await piped206.text()).toBe('PNG!');

      const res302 = await executeSidecarAssetServe({
        owner: 'octo',
        repo: 'demo',
        path: 'cdn.png',
      });
      const piped302 = pipeSidecarAssetResponse(res302!);
      expect(piped302.status).toBe(302);
      expect(piped302.headers.get('location')).toBe('https://cdn.example.com/cdn.png');
      expect(await piped302.text()).toBe('');

      const res304 = await executeSidecarAssetServe({
        owner: 'octo',
        repo: 'demo',
        path: 'cached.png',
      });
      const piped304 = pipeSidecarAssetResponse(res304!);
      expect(piped304.status).toBe(304);
      expect(await piped304.text()).toBe('');

      const res404 = await executeSidecarAssetServe({
        owner: 'octo',
        repo: 'demo',
        path: 'missing.png',
      });
      expect(res404?.status).toBe(404);
    });

    it('fails open (returns null) on 5xx, 401, missing token, or unreachable endpoint', async () => {
      routeHandler = (_req, res) => {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('bad gateway');
      };
      expect(
        await executeSidecarAssetServe({ owner: 'octo', repo: 'demo', path: 'a.png' })
      ).toBeNull();

      routeHandler = (_req, res) => {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
      };
      expect(
        await executeSidecarAssetServe({ owner: 'octo', repo: 'demo', path: 'a.png' })
      ).toBeNull();

      // Unreachable port
      expect(
        await executeSidecarAssetServe({
          owner: 'octo',
          repo: 'demo',
          path: 'a.png',
          endpoint: 'http://127.0.0.1:1',
          timeoutMs: 500,
        })
      ).toBeNull();
    });
  });

  describe('fingerprint-driver (computeReadingFingerprintBatchViaSidecar)', () => {
    it('short-circuits empty input and sends merged config + wire-projected events', async () => {
      expect(await computeReadingFingerprintBatchViaSidecar([])).toEqual({});
      expect(recorded).toHaveLength(0);

      routeHandler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            results: {
              'repo-1': {
                overallProgress: 75,
                totalChapters: 2,
                effectivelyRead: 1,
                chapterScores: [
                  { path: 'a.md', score: 90, isRead: true },
                  { path: 'b.md', score: 60, isRead: false },
                ],
              },
            },
          })
        );
      };

      const createdAt = new Date('2026-06-01T10:00:00.000Z');
      const out = await computeReadingFingerprintBatchViaSidecar(
        [
          {
            repoId: 'repo-1',
            chapters: [{ path: 'a.md', wordCount: 500, codeBlockCount: 2, headingCount: 3 }],
            events: [
              {
                eventType: 'PAGE_VIEW',
                pageUrl: '/docs/octo/demo/a',
                duration: 15_000,
                createdAt,
                metadata: { scrollPercent: 80 },
              },
            ],
          },
        ],
        { weights: { sectionCoverage: 0.7, timeAdequacy: 0.3, skipPenalty: 0, revisitBonus: 0 } }
      );

      expect(out['repo-1'].overallProgress).toBe(75);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].pathname).toBe('/v1/fingerprint/compute-batch');
      expect(recorded[0].headers['x-internal-token']).toBe(TEST_INTERNAL_TOKEN);

      const sent = recorded[0].bodyJson as {
        items: Array<{ repoId: string; events: Array<Record<string, unknown>> }>;
        config: { weights: { sectionCoverage: number }; thresholds: { readingSpeedWpm: number } };
      };
      expect(sent.config.weights.sectionCoverage).toBe(0.7);
      expect(sent.config.thresholds.readingSpeedWpm).toBe(300);
      expect(sent.items[0].events[0].createdAt).toBe(createdAt.toISOString());
      expect(sent.items[0].events[0].targetId).toBeUndefined();
    });

    it('fails closed on malformed payload and HTTP 500', async () => {
      routeHandler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, results: { 'repo-1': { bad: true } } }));
      };
      await expect(
        computeReadingFingerprintBatchViaSidecar([{ repoId: 'repo-1', chapters: [], events: [] }])
      ).rejects.toThrow(/malformed result payload/);

      routeHandler = (_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'db down' }));
      };
      await expect(
        computeReadingFingerprintBatchViaSidecar([{ repoId: 'repo-1', chapters: [], events: [] }])
      ).rejects.toMatchObject({ name: 'SidecarError', status: 500 });
    });
  });

  describe('llms-txt-driver (executeSidecarLlmsTxt)', () => {
    it('serializes llms.txt options and fails closed on sidecar HTTP error', async () => {
      routeHandler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            content: '# octo/demo\n\n> Summary',
            estimatedTokens: 420,
            downgradedCount: 1,
            targetVersion: 'v2',
          })
        );
      };

      const res = await executeSidecarLlmsTxt({
        repositoryId: 'repo-1',
        owner: 'octo',
        repo: 'demo',
        version: 'v2',
        baseUrl: 'https://opengits.dev',
        full: true,
        budget: 8000,
        topic: 'auth',
        mode: 'strict',
        userId: 'user-1',
      });

      expect(res).toEqual({
        content: '# octo/demo\n\n> Summary',
        estimatedTokens: 420,
        downgradedCount: 1,
        targetVersion: 'v2',
      });
      expect(recorded[0].pathname).toBe('/v1/llms-txt/generate');
      expect(recorded[0].bodyJson).toMatchObject({
        repositoryId: 'repo-1',
        full: true,
        budget: 8000,
        mode: 'strict',
        userId: 'user-1',
      });

      routeHandler = (_req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'pool exhausted' }));
      };
      await expect(
        executeSidecarLlmsTxt({
          repositoryId: 'repo-1',
          owner: 'octo',
          repo: 'demo',
          baseUrl: 'https://opengits.dev',
        })
      ).rejects.toMatchObject({ name: 'SidecarError', status: 503 });
    });
  });

  describe('scout-driver (executeSidecarScoutInspect)', () => {
    it('returns parsed inspection payload and distinguishes 4xx, 5xx & ok=false', async () => {
      routeHandler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            archiveUsed: true,
            totalNodeCount: 12,
            markdownFiles: [{ path: 'README.md', type: 'blob' }],
            profile: { ingestMode: 'hybrid', docCodeRatio: 0.4 },
            scale: { tier: 'small', totalFiles: 12 },
            dirTree: [],
            exclusionReport: { excludedCount: 0, groups: [] },
            skeleton: 'README.md',
            skeletonHash: 'hash-1',
            truncated: false,
          })
        );
      };

      const okRes = await executeSidecarScoutInspect({
        owner: 'octo',
        repo: 'demo',
        branch: 'main',
        maxDepth: 3,
        stars: 100,
      });
      expect(okRes.archiveUsed).toBe(true);
      expect(okRes.totalNodeCount).toBe(12);
      expect(recorded[0].pathname).toBe('/v1/scout/inspect');

      routeHandler = (_req, res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid owner/repo' }));
      };
      const err400 = await executeSidecarScoutInspect({ owner: 'octo', repo: 'bad' }).catch((e) => e);
      expect(err400).toBeInstanceOf(SidecarError);
      expect((err400 as SidecarError).status).toBe(400);

      routeHandler = (_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'tarball corrupt' }));
      };
      const err500 = await executeSidecarScoutInspect({ owner: 'octo', repo: 'demo' }).catch((e) => e);
      expect(err500).toBeInstanceOf(SidecarError);
      expect((err500 as SidecarError).status).toBe(500);

      routeHandler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      };
      await expect(executeSidecarScoutInspect({ owner: 'octo', repo: 'demo' })).rejects.toThrow(
        /ok is false/
      );
    });
  });

  describe('tree-outline-driver (executeSidecarTreeOutline)', () => {
    it('handles JSON depth 1/2, 202 preparing, and malformed depth validation', async () => {
      routeHandler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            depth: 1,
            repo: 'octo/demo',
            chapters: [{ name: 'Intro', summary: 'Overview', files: [] }],
          })
        );
      };
      const d1 = await executeSidecarTreeOutline({
        owner: 'octo',
        repo: 'demo',
        sha: 'abc',
        userId: 'u1',
        rollupLevel: 0,
      });
      expect(d1.depth).toBe(1);
      expect((recorded[0].bodyJson as { rollupLevel?: number }).rollupLevel).toBe(0);

      // 202 preparing bypasses depth check
      routeHandler = (_req, res) => {
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, preparing: true, retryAfterMs: 1500 }));
      };
      const prep = await executeSidecarTreeOutline({
        owner: 'octo',
        repo: 'demo',
        sha: 'abc',
        userId: 'u1',
      });
      expect(prep.preparing).toBe(true);
      expect(prep.retryAfterMs).toBe(1500);

      // Malformed depth or depth=2 without courseTree fails closed
      routeHandler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, depth: 2, repo: 'octo/demo' }));
      };
      await expect(
        executeSidecarTreeOutline({ owner: 'octo', repo: 'demo', sha: 'abc', userId: 'u1' })
      ).rejects.toThrow(/depth 2 without courseTree/);
    });

    it('parses SSE step/complete frames and routes SSE error frames with upstream metadata', async () => {
      routeHandler = (_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.write(': keepalive\n\n');
        res.write('event: step\ndata: {"stage":"scan","title":"Scanning","detail":"12 files","progress":25}\n\n');
        res.write(
          'event: complete\ndata: ' +
            JSON.stringify({
              data: {
                ok: true,
                depth: 1,
                repo: 'octo/demo',
                chapters: [{ name: 'Architecture', summary: 'Core', files: [] }],
              },
            }) +
            '\n\n'
        );
        res.end();
      };

      const steps: Array<{ stage: string; progress?: number }> = [];
      const res = await executeSidecarTreeOutline(
        { owner: 'octo', repo: 'demo', sha: 'abc', userId: 'u1' },
        { stream: true, onProgress: (s) => steps.push({ stage: s.stage, progress: s.progress }) }
      );
      expect(recorded[0].headers['accept']).toBe('text/event-stream');
      expect(steps).toEqual([{ stage: 'scan', progress: 25 }]);
      expect(res.chapters?.[0].name).toBe('Architecture');

      // SSE error event preserves structured upstream error fields
      routeHandler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          'event: error\ndata: ' +
            JSON.stringify({
              message: 'Quota exceeded',
              code: 'UPSTREAM_QUOTA_EXCEEDED',
              status: 402,
              provider: 'openai',
              model: 'gpt-4o-mini',
              upstreamStatus: 429,
              upstreamCode: 'insufficient_quota',
              upstreamMessage: 'billing hard limit',
            }) +
            '\n\n'
        );
        res.end();
      };

      const sseErr = await executeSidecarTreeOutline(
        { owner: 'octo', repo: 'demo', sha: 'abc', userId: 'u1' },
        { stream: true }
      ).catch((e) => e);
      expect(sseErr).toMatchObject({
        message: 'Quota exceeded',
        code: 'UPSTREAM_QUOTA_EXCEEDED',
        status: 402,
        provider: 'openai',
        model: 'gpt-4o-mini',
        upstreamStatus: 429,
        upstreamCode: 'insufficient_quota',
        upstreamMessage: 'billing hard limit',
      });
    });
  });

  describe('macro-topology-enricher (Non-DB grounding & fail-open)', () => {
    const sampleTopo: MacroTopology = {
      scope: 'root',
      scale: 1,
      strategy: 'pagerank',
      nodes: [
        { id: 'n_api', path: 'src/api', name: 'api', role: 'interface', fileCount: 4, loc: 500, hotness: 0.9 },
        { id: 'n_core', path: 'src/core', name: 'core', role: 'core', fileCount: 8, loc: 1600, hotness: 1.0 },
      ],
      edges: [{ from: 'n_api', to: 'n_core', weight: 3, symbols: ['dispatch'] }],
      rawMermaid: '```mermaid\nflowchart TD\n  n_api --> n_core\n```',
      mermaid: '```mermaid\nflowchart TD\n  n_api --> n_core\n```',
    };

    it('drops hallucinated nodes/edges in assembleEnrichedMermaid and falls back safely without user key', async () => {
      const emptyTopo = { ...sampleTopo, nodes: [] };
      expect(await enrichMacroTopologyWithLlm(emptyTopo, 'octo/demo', null)).toBe(emptyTopo);

      // Missing userId for BYOK purpose fails open to rawMermaid
      const noKeyRes = await enrichMacroTopologyWithLlm(sampleTopo, 'octo/demo', null);
      expect(noKeyRes.mermaid).toBe(sampleTopo.rawMermaid);

      const grounded = assembleEnrichedMermaid(sampleTopo, {
        nodes: [
          { id: 'n_api', title: 'HTTP Gateway', subtitle: 'Handles requests', layer: 'interface' },
          { id: 'n_hallucinated', title: 'Ghost Node', subtitle: 'Not in physical graph', layer: 'core' },
        ],
        edges: [
          { from: 'n_api', to: 'n_core', label: 'dispatches commands' },
          { from: 'n_api', to: 'n_hallucinated', label: 'bad edge' },
        ],
      });
      expect(grounded).toContain('HTTP Gateway');
      expect(grounded).toContain('dispatches commands');
      expect(grounded).not.toContain('Ghost Node');
      expect(grounded).not.toContain('bad edge');
    });
  });

  describe.skipIf(!HAS_TEST_DB)('DB-backed Sidecar & LLM HTTP Integration', () => {
    const createdUserIds: string[] = [];
    const createdRepoIds: string[] = [];

    afterAll(async () => {
      if (createdRepoIds.length > 0) {
        await prisma.repository.deleteMany({ where: { id: { in: createdRepoIds } } }).catch(() => {});
      }
      if (createdUserIds.length > 0) {
        await prisma.userModelProvider.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
      }
    });

    it('wires GET /api/llms-txt/[owner]/[repo] -> real DB repo -> ephemeral node:http sidecar', async () => {
      const owner = uniqueTestTag('llms-owner');
      const repoName = uniqueTestTag('llms-repo');
      const repo = await prisma.repository.create({
        data: { owner, repo: repoName, branch: ENGINE_CONFIG.defaultBranch, isPublic: true },
      });
      createdRepoIds.push(repo.id);

      routeHandler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            content: `# ${owner}/${repoName}\n\n- Guide`,
            estimatedTokens: 321,
            downgradedCount: 2,
            targetVersion: 'v1.2.0',
          })
        );
      };

      const { GET } = await import('@/app/api/llms-txt/[owner]/[repo]/route');
      const okRes = await GET(
        new NextRequest(`http://localhost/api/llms-txt/${owner}/${repoName}?full=true&budget=4000&mode=strict`),
        { params: Promise.resolve({ owner, repo: repoName }) }
      );
      expect(okRes.status).toBe(200);
      expect(okRes.headers.get('content-type')).toContain('text/plain');
      expect(okRes.headers.get('x-estimated-tokens')).toBe('321');
      expect(okRes.headers.get('x-downgraded-count')).toBe('2');
      expect(okRes.headers.get('x-target-version')).toBe('v1.2.0');
      expect(await okRes.text()).toContain(`# ${owner}/${repoName}`);
      expect(recorded[0].pathname).toBe('/v1/llms-txt/generate');

      const notFoundRes = await GET(
        new NextRequest(`http://localhost/api/llms-txt/${owner}/nonexistent-repo`),
        { params: Promise.resolve({ owner, repo: 'nonexistent-repo' }) }
      );
      expect(notFoundRes.status).toBe(404);
    });

    it('enriches macro topology via real OpenAI-compatible HTTP endpoint and falls back on 500', async () => {
      const user = await createTestUser('macro-llm');
      createdUserIds.push(user.id);

      await prisma.userModelProvider.create({
        data: {
          userId: user.id,
          providerKey: 'custom',
          name: 'Local Ephemeral LLM',
          baseUrl: `${baseUrl}/v1`,
          apiKey: encryptApiKey('sk-it-macro-secret'),
          apiFormat: 'openai',
          models: ['gpt-4o-mini'],
          selectedModel: 'gpt-4o-mini',
          isActive: true,
        },
      });

      const topo: MacroTopology = {
        scope: 'root',
        scale: 1,
        strategy: 'pagerank',
        nodes: [
          { id: 'n_api', path: 'src/api', name: 'api', role: 'interface', fileCount: 3, loc: 400, hotness: 0.9 },
          { id: 'n_db', path: 'src/db', name: 'db', role: 'storage', fileCount: 2, loc: 300, hotness: 0.8 },
        ],
        edges: [{ from: 'n_api', to: 'n_db', weight: 2, symbols: ['query'] }],
        rawMermaid: '```mermaid\nflowchart TD\n  n_api --> n_db\n```',
        mermaid: '```mermaid\nflowchart TD\n  n_api --> n_db\n```',
      };

      routeHandler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-it-1',
            object: 'chat.completion',
            created: 1700000000,
            model: 'gpt-4o-mini',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    nodes: [
                      { id: 'n_api', title: 'API 网关', subtitle: '路由鉴权', layer: 'interface' },
                      { id: 'n_db', title: '存储层', subtitle: '持久查询', layer: 'storage' },
                    ],
                    edges: [{ from: 'n_api', to: 'n_db', label: '执行 SQL 查询' }],
                    summary: '清晰的接口到存储分层架构。',
                  }),
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 40, total_tokens: 90 },
          })
        );
      };

      const enriched = await enrichMacroTopologyWithLlm(topo, 'octo/demo', user.id, 'zh-CN');
      expect(enriched.mermaid).toContain('API 网关');
      expect(enriched.mermaid).toContain('执行 SQL 查询');
      expect(enriched.summary).toBe('清晰的接口到存储分层架构。');
      expect(recorded.some((r) => r.pathname === '/v1/chat/completions')).toBe(true);
      const llmReq = recorded.find((r) => r.pathname === '/v1/chat/completions')!;
      expect(llmReq.headers['authorization']).toBe('Bearer sk-it-macro-secret');

      // Upstream 500 falls back gracefully to physical rawMermaid skeleton
      routeHandler = (_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream crashed', type: 'server_error' } }));
      };
      const fallback = await enrichMacroTopologyWithLlm(topo, 'octo/demo', user.id, 'zh-CN');
      expect(fallback.mermaid).toBe(topo.rawMermaid);
    });
  });
});
