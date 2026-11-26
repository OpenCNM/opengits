import http from 'node:http';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import {
  inspectGithubUrl,
  isPrivateOrLoopbackHost,
  isPublicHttpEndpoint,
} from '@/lib/url-inspector';
import {
  API_ERROR_CODES,
  ApiError,
  toApiErrorFromLlm,
} from '@/lib/api/server/api-error';
import { assert, assertFound } from '@/lib/api/server/api-guards';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiClientError, apiFetch } from '@/lib/api/client';
import {
  decryptApiKey,
  encryptApiKey,
  isEncryptedApiKey,
  maskApiKey,
} from '@/lib/crypto/api-key-cipher';
import { enforceMcpAuth, enforceMcpAuthAndQuota } from '@/lib/mcp/request-guard';
import { isMachineExemptPath } from '@/lib/gateway/policy';
import {
  checkDocumentAccess,
  checkRepositoryAccess,
  docVisibilityFilter,
  verifyRepoAccessDirect,
} from '@/lib/auth-utils';
import {
  mergeMonotonicScores,
  shouldPurgeReadingProgressKey,
} from '@/lib/stores/reading-progress-store';
import {
  filterRestoredSessions,
  sanitizeSessions,
  type Difficulty,
  type QuizSession,
} from '@/components/mdx/useQuizSession';
import { generatePaginationPages } from '@/components/settings/PublicationsPagination';
import { PUBLICATIONS_PAGINATION } from '@/lib/constants';
import {
  flushQueue,
  setTelemetryAuthenticated,
  trackEvent,
} from '@/lib/telemetry/beacon';
import { HAS_TEST_DB, createTestUser, uniqueTestTag } from './_test-env';

/**
 * Black-Box API Auth, Visibility Isolation, SSRF & Error Envelope Integration Suite.
 *
 * Supersedes mocked unit tests:
 * - api-define-route, api-key-cipher, api-client, api-*-sidecar,
 *   mcp-request-guard-sidecar-skip, mcp-oauth-resource, mcp-tokens-route,
 *   mcp-bundle-route.
 */

describe('SSRF & URL Validation Boundaries (Non-DB)', () => {
  it('blocks loopback, private CIDR, cloud metadata, alternate IP encodings & forbidden ports', () => {
    const blockedHosts = [
      'localhost',
      '127.0.0.1',
      '0x7f000001',
      '017700000001',
      '2130706433',
      '::1',
      '::ffff:127.0.0.1',
      '169.254.169.254',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      'metadata',
      'redis.internal',
      'service.local',
    ];
    for (const host of blockedHosts) {
      expect(isPrivateOrLoopbackHost(host), `host=${host}`).toBe(true);
      expect(isPublicHttpEndpoint(`http://${host}/v1`), `url=${host}`).toBe(false);
    }

    expect(isPublicHttpEndpoint('https://api.openai.com:5432/v1')).toBe(false);
    expect(isPublicHttpEndpoint('https://api.openai.com:6379/v1')).toBe(false);
    expect(isPublicHttpEndpoint('file:///etc/passwd')).toBe(false);
    expect(isPublicHttpEndpoint('ftp://example.com/file')).toBe(false);
    expect(isPublicHttpEndpoint('https://api.openai.com/v1')).toBe(true);
  });

  it('classifies GitHub repos, blobs, reserved namespaces, path traversal & web-doc URLs', () => {
    expect(inspectGithubUrl('https://github.com/vercel/next.js')).toMatchObject({
      isValid: true,
      status: 'SUCCESS',
      owner: 'vercel',
      repo: 'next.js',
      resourceType: 'repo',
    });

    expect(inspectGithubUrl('git@github.com:facebook/react.git')).toMatchObject({
      isValid: true,
      status: 'SUCCESS',
      owner: 'facebook',
      repo: 'react',
    });

    expect(inspectGithubUrl('https://github.com/owner/repo/blob/main/docs/intro.md')).toMatchObject({
      isValid: true,
      status: 'BLOB_INTENT',
      isBlobUrl: true,
      branch: 'main',
      filePath: 'docs/intro.md',
    });

    expect(inspectGithubUrl('https://github.com/orgs/vercel').status).toBe('UNSUPPORTED_RESOURCE');
    expect(inspectGithubUrl('https://github.com/owner/repo/issues/1').status).toBe('UNSUPPORTED_RESOURCE');
    expect(inspectGithubUrl('https://github.com/owner/../evil').status).toBe('INVALID_FORMAT');
    expect(inspectGithubUrl('http://127.0.0.1:8080/docs').status).toBe('UNSUPPORTED_DOMAIN');
    expect(inspectGithubUrl('https://docs.python.org/3/').status).toBe('WEB_DOC_URL');
  });
});

describe('API Error Envelopes, defineRoute Auth/Validation & Crypto (Non-DB)', () => {
  it('maps ApiError codes, guards & LLM upstream errors to consistent HTTP statuses', () => {
    expect(assertFound({ id: '1' })).toEqual({ id: '1' });
    expect(() => assertFound(null, 'missing')).toThrow(ApiError);
    expect(() => assert(false, 'FORBIDDEN', 'no access')).toThrow(ApiError);

    try {
      assert(false, 'CONFLICT', 'dup');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).code).toBe(API_ERROR_CODES.CONFLICT);
    }

    const mapped = toApiErrorFromLlm(new Error('401 Unauthorized'), 'fallback');
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped.status).toBeGreaterThanOrEqual(400);
  });

  it('enforces defineRoute success envelope, Zod validation, auth gates & 500 redaction', async () => {
    const schema = z.object({
      count: z.number().int().positive('数量必须大于 0'),
    });

    const openRoute = defineRoute({
      scope: 'test/open',
      auth: 'none',
      bodySchema: schema,
      handler: ({ body }) => ok({ doubled: body.count * 2 }, 201),
    });

    const okRes = await openRoute(
      new NextRequest('http://localhost/api/test', {
        method: 'POST',
        body: JSON.stringify({ count: 5 }),
      }),
      { params: Promise.resolve({}) }
    );
    expect(okRes.status).toBe(201);
    expect(await okRes.json()).toEqual({ success: true, data: { doubled: 10 } });

    const badRes = await openRoute(
      new NextRequest('http://localhost/api/test', {
        method: 'POST',
        body: JSON.stringify({ count: -1 }),
      }),
      { params: Promise.resolve({}) }
    );
    expect(badRes.status).toBe(400);
    const badJson = (await badRes.json()) as { success: boolean; code?: string; error: string };
    expect(badJson.success).toBe(false);
    expect(badJson.code).toBe('VALIDATION_ERROR');
    expect(badJson.error).toContain('数量必须大于 0');

    const crashRoute = defineRoute({
      scope: 'test/crash',
      auth: 'none',
      handler: () => {
        throw new Error('secret-db-password-leak');
      },
    });
    const crashRes = await crashRoute(new NextRequest('http://localhost/api/crash'), {
      params: Promise.resolve({}),
    });
    expect(crashRes.status).toBe(500);
    const crashJson = (await crashRes.json()) as { success: boolean; error: string; code: string };
    expect(crashJson).toEqual({
      success: false,
      error: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
    });

    const userRoute = defineRoute({
      scope: 'test/user',
      auth: 'user',
      handler: ({ userId }) => ok({ userId }),
    });
    const unauthRes = await userRoute(new NextRequest('http://localhost/api/user'), {
      params: Promise.resolve({}),
    });
    expect(unauthRes.status).toBe(401);
    expect(await unauthRes.json()).toMatchObject({ success: false, code: 'UNAUTHORIZED' });

    const adminRoute = defineRoute({
      scope: 'test/admin',
      auth: 'admin',
      handler: ({ adminEmail }) => ok({ adminEmail }),
    });
    const nonAdminRes = await adminRoute(new NextRequest('http://localhost/api/admin'), {
      params: Promise.resolve({}),
    });
    expect(nonAdminRes.status).toBe(403);
    expect(await nonAdminRes.json()).toMatchObject({ success: false, code: 'FORBIDDEN' });
  });

  it('encrypts/decrypts API keys idempotently and fails closed on tampered ciphertext', () => {
    const raw = 'sk-test-1234567890abcdef';
    const enc = encryptApiKey(raw);
    expect(isEncryptedApiKey(enc)).toBe(true);
    expect(enc).not.toContain(raw);
    expect(encryptApiKey(enc)).toBe(enc); // idempotent
    expect(decryptApiKey(enc)).toBe(raw);
    expect(decryptApiKey(raw)).toBe(raw); // legacy plaintext passthrough
    expect(maskApiKey(raw)).toBe('sk-te••••••••••••cdef');

    // Tampered auth tag / malformed payload throws rather than returning ciphertext
    expect(() => decryptApiKey('enc:v1:invalid:parts')).toThrow();
    const segments = enc.split(':');
    segments[4] = Buffer.from('tampered').toString('base64');
    expect(() => decryptApiKey(segments.join(':'))).toThrow();
  });

  it('enforces MCP auth challenge & rejects forged sidecar quota-skip headers', async () => {
    const forgedReq = new NextRequest('http://localhost/api/mcp/hub', {
      method: 'POST',
      headers: {
        authorization: 'Bearer opgts_invalid_000000000000000000000000',
        'x-mcp-quota-checked': '1',
        'x-internal-token': 'forged-token-value',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 1 }),
    });
    const res = await enforceMcpAuthAndQuota(forgedReq, { rpc: true });
    expect(res.userId).toBe('');
    expect(res.response).not.toBeNull();
    expect(res.response!.status).toBe(401);
    expect(res.response!.headers.get('WWW-Authenticate')).toContain('Bearer');

    const authOnly = await enforceMcpAuth(
      new NextRequest('http://localhost/api/mcp/hub', {
        headers: { authorization: 'Bearer invalid' },
      })
    );
    expect(authOnly.response?.status).toBe(401);

    expect(isMachineExemptPath('/api/health')).toBe(true);
    expect(isMachineExemptPath('/api/internal/revalidate')).toBe(true);
    expect(isMachineExemptPath('/api/update/jobs/batch-claim')).toBe(false);
  });
});

describe.skipIf(!HAS_TEST_DB)('Visibility Isolation & Real Route Handler Boundaries (Real DB)', () => {
  const createdUserIds: string[] = [];
  const createdRepoIds: string[] = [];

  afterAll(async () => {
    if (createdRepoIds.length > 0) {
      await prisma.savedRepo.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
      await prisma.document.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
      await prisma.repository.deleteMany({ where: { id: { in: createdRepoIds } } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
  });

  it('isolates private repositories and private document rows across users & guests', async () => {
    const userA = await createTestUser('vis-a');
    const userB = await createTestUser('vis-b');
    createdUserIds.push(userA.id, userB.id);

    const publicRepo = await prisma.repository.create({
      data: { owner: uniqueTestTag('vis-pub'), repo: 'pub', branch: ENGINE_CONFIG.defaultBranch, isPublic: true },
    });
    const privateRepo = await prisma.repository.create({
      data: { owner: uniqueTestTag('vis-priv'), repo: 'priv', branch: ENGINE_CONFIG.defaultBranch, isPublic: false },
    });
    createdRepoIds.push(publicRepo.id, privateRepo.id);

    await prisma.savedRepo.create({
      data: { userId: userA.id, repositoryId: privateRepo.id },
    });

    const sharedDoc = await prisma.document.create({
      data: { repositoryId: publicRepo.id, ownerUserId: null, path: 'shared.md', status: 'PROCESSED', content: 'shared' },
    });
    const privDocA = await prisma.document.create({
      data: { repositoryId: publicRepo.id, ownerUserId: userA.id, path: 'priv-a.md', status: 'PROCESSED', content: 'secret-a' },
    });
    const privRepoDoc = await prisma.document.create({
      data: { repositoryId: privateRepo.id, ownerUserId: null, path: 'repo-priv.md', status: 'PROCESSED', content: 'repo-priv' },
    });

    // Repository access checks
    expect(await checkRepositoryAccess(publicRepo.id, undefined)).toBe(true);
    expect(await checkRepositoryAccess(privateRepo.id, undefined)).toBe(false);
    expect(await checkRepositoryAccess(privateRepo.id, userA.id)).toBe(true);
    expect(await checkRepositoryAccess(privateRepo.id, userB.id)).toBe(false);
    expect(await verifyRepoAccessDirect({ id: privateRepo.id, isPublic: false, savedRepos: [] }, userB.id)).toBe(false);

    // Document access checks (true-freeze isolation)
    expect(await checkDocumentAccess(sharedDoc.id, undefined)).toBe(true);
    expect(await checkDocumentAccess(privDocA.id, undefined)).toBe(false);
    expect(await checkDocumentAccess(privDocA.id, userA.id)).toBe(true);
    expect(await checkDocumentAccess(privDocA.id, userB.id)).toBe(false);
    expect(await checkDocumentAccess(privRepoDoc.id, userA.id)).toBe(true);
    expect(await checkDocumentAccess(privRepoDoc.id, userB.id)).toBe(false);

    expect(docVisibilityFilter(null)).toEqual({ ownerUserId: null });
    expect(docVisibilityFilter(userA.id)).toEqual({ OR: [{ ownerUserId: null }, { ownerUserId: userA.id }] });
  });

  it('invokes real Next.js route handlers for /api/user/credits and /api/update/jobs/batch-claim', async () => {
    const creditsRoute = await import('@/app/api/user/credits/route');
    const creditsRes = await creditsRoute.GET(new NextRequest('http://localhost/api/user/credits'), {
      params: Promise.resolve({}),
    });
    expect(creditsRes.status).toBe(200);
    const creditsBody = (await creditsRes.json()) as { success: boolean; data: { loggedIn: boolean; dailyLimit: number } };
    expect(creditsBody.success).toBe(true);
    expect(creditsBody.data.loggedIn).toBe(false);
    expect(creditsBody.data.dailyLimit).toBeGreaterThan(0);

    const batchClaimRoute = await import('@/app/api/update/jobs/batch-claim/route');
    const unauthClaimRes = await batchClaimRoute.POST(
      new NextRequest('http://localhost/api/update/jobs/batch-claim', {
        method: 'POST',
        body: JSON.stringify({ jobIds: ['job-1'] }),
      }),
      { params: Promise.resolve({}) }
    );
    expect(unauthClaimRes.status).toBe(401);
    expect(await unauthClaimRes.json()).toMatchObject({ success: false, code: 'UNAUTHORIZED' });
  });
});

describe('Client Resilience, Pagination, Reading/Quiz State & Telemetry Beacon (Non-DB)', () => {
  it('enforces monotonic reading progress & exact repo prefix purge without substring leaks', () => {
    const current = { 'facebook/react:intro': 80, 'facebook/react:hooks': 100 };
    const incomingLower = { 'facebook/react:intro': 20, 'facebook/react:hooks': 50 };
    const noRegress = mergeMonotonicScores(current, incomingLower);
    expect(noRegress.hasDiff).toBe(false);
    expect(noRegress.merged).toEqual(current);

    const incomingHigher = { 'facebook/react:intro': 95, 'facebook/react:new-doc': 40 };
    const progressed = mergeMonotonicScores(current, incomingHigher);
    expect(progressed.hasDiff).toBe(true);
    expect(progressed.merged).toEqual({
      'facebook/react:intro': 95,
      'facebook/react:hooks': 100,
      'facebook/react:new-doc': 40,
    });

    const repoKey = 'facebook/react';
    expect(shouldPurgeReadingProgressKey('reading_pos_v2_facebook/react:intro', repoKey)).toBe(true);
    expect(shouldPurgeReadingProgressKey('reading_pos_facebook/react:intro', repoKey)).toBe(true);
    expect(shouldPurgeReadingProgressKey('facebook/react:intro', repoKey)).toBe(true);
    expect(shouldPurgeReadingProgressKey('user_reactions_setting', repoKey)).toBe(false);
    expect(shouldPurgeReadingProgressKey('my-facebook/react-native:doc', repoKey)).toBe(false);
    expect(shouldPurgeReadingProgressKey('reading_pos_v2_facebook/react-native:intro', repoKey)).toBe(false);
  });

  it('sanitizes unsubmitted quiz answers and drops unrevealed restored sessions', () => {
    const input: Record<Difficulty, QuizSession> = {
      easy: {
        quizzes: [
          { question: 'Q1', options: ['A', 'B'], correctIndex: 0 },
          { question: 'Q2', options: ['A', 'B'], correctIndex: 1 },
        ],
        answers: { 0: 0 },
        submitted: { 0: true, 1: false },
        hasStarted: true,
      },
      medium: {
        quizzes: [{ question: 'Q3', options: ['A', 'B'], correctIndex: 1 }],
        answers: { 0: 1 },
        submitted: { 0: true },
        hasStarted: true,
      },
      hard: { quizzes: [], answers: {}, submitted: {}, hasStarted: false },
    };

    const sanitized = sanitizeSessions(input);
    expect(sanitized.easy.quizzes[0].correctIndex).toBe(0);
    expect(sanitized.easy.quizzes[1].correctIndex).toBe(-1);

    const restored = filterRestoredSessions(sanitized);
    expect(restored.easy.quizzes).toHaveLength(0);
    expect(restored.easy.hasStarted).toBe(false);
    expect(restored.medium.quizzes).toHaveLength(1);
    expect(restored.medium.hasStarted).toBe(true);
  });

  it('generates pagination sequences and clamps page slices cleanly across edge ranges', () => {
    expect(PUBLICATIONS_PAGINATION.PAGE_SIZE).toBe(10);
    expect(generatePaginationPages(1, 0)).toEqual([]);
    expect(generatePaginationPages(1, -5)).toEqual([]);
    expect(generatePaginationPages(1, 1)).toEqual([1]);
    expect(generatePaginationPages(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(generatePaginationPages(1, 10)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 10]);
    expect(generatePaginationPages(4, 10)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 10]);
    expect(generatePaginationPages(7, 10)).toEqual([1, 'ellipsis', 6, 7, 8, 9, 10]);
    expect(generatePaginationPages(10, 10)).toEqual([1, 'ellipsis', 6, 7, 8, 9, 10]);
    expect(generatePaginationPages(5, 10)).toEqual([1, 'ellipsis', 4, 5, 6, 'ellipsis', 10]);
    expect(generatePaginationPages(10, 20)).toEqual([1, 'ellipsis', 9, 10, 11, 'ellipsis', 20]);

    const totalItems = 27;
    const pageSize = PUBLICATIONS_PAGINATION.PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    expect(totalPages).toBe(3);
    const clampPage = (p: number) => Math.min(Math.max(1, p), totalPages);
    expect([clampPage(0), clampPage(-5), clampPage(2), clampPage(99)]).toEqual([1, 1, 2, 3]);
    expect(Math.min(3 * pageSize, totalItems) - (3 - 1) * pageSize).toBe(7);
  });

  it('handles apiFetch envelope unwrapping, in-flight GET dedup & telemetry 429 cooldown over real HTTP', async () => {
    let getHits = 0;
    let telemetryStatus = 200;
    const telemetryBodies: Array<{ events: Array<{ eventType: string; duration?: number; metadata?: Record<string, unknown> }> }> = [];

    const server = http.createServer(async (req, res) => {
      if (req.url === '/api/dedup' && req.method === 'GET') {
        getHits++;
        await new Promise((r) => setTimeout(r, 25));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { hits: getHits } }));
        return;
      }
      if (req.url === '/api/fail' && req.method === 'GET') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'conflict', code: 'CONFLICT', detail: 'stale' }));
        return;
      }
      if (req.url === '/api/unauth' && req.method === 'GET') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'unauthorized', code: 'UNAUTHORIZED' }));
        return;
      }
      if (req.url === '/api/telemetry' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        telemetryBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(telemetryStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: telemetryStatus < 400 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const realFetch = globalThis.fetch;

    try {
      // 1. Real HTTP apiFetch envelope unwrap, GET dedup & failure mapping
      const [d1, d2] = await Promise.all([
        apiFetch<{ hits: number }>(`${baseUrl}/api/dedup`),
        apiFetch<{ hits: number }>(`${baseUrl}/api/dedup`),
      ]);
      expect(getHits).toBe(1);
      expect(d1).toEqual({ hits: 1 });
      expect(d2).toEqual({ hits: 1 });

      await expect(apiFetch(`${baseUrl}/api/fail`)).rejects.toMatchObject({
        name: 'ApiClientError',
        status: 409,
        code: 'CONFLICT',
        detail: 'stale',
      });
      await expect(
        apiFetch(`${baseUrl}/api/unauth`, { onUnauthorized: 'throw' })
      ).rejects.toBeInstanceOf(ApiClientError);

      // 2. Telemetry beacon: unauthenticated drop -> monotonic SCROLL_PROGRESS dedup -> 429 cooldown
      vi.stubGlobal('window', { location: { pathname: '/docs/ch1' } });
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' && input.startsWith('/') ? `${baseUrl}${input}` : input;
        return realFetch(url, init);
      });

      setTelemetryAuthenticated(false);
      trackEvent({ eventType: 'PAGE_VIEW', targetId: '/docs/ch1', immediate: true });
      await new Promise((r) => setTimeout(r, 20));
      expect(telemetryBodies).toHaveLength(0);

      setTelemetryAuthenticated(true);
      trackEvent({
        eventType: 'SCROLL_PROGRESS',
        targetId: '/docs/ch1',
        duration: 1000,
        metadata: { scrollPercent: 30 },
      });
      trackEvent({
        eventType: 'SCROLL_PROGRESS',
        targetId: '/docs/ch1',
        duration: 5000,
        metadata: { scrollPercent: 80 },
      });
      flushQueue();
      await new Promise((r) => setTimeout(r, 40));
      expect(telemetryBodies).toHaveLength(1);
      expect(telemetryBodies[0].events).toHaveLength(1);
      expect(telemetryBodies[0].events[0].metadata?.scrollPercent).toBe(80);
      expect(telemetryBodies[0].events[0].duration).toBe(5000);

      // Server returns 429 -> enters 60s cooldown, suppressing subsequent flush
      telemetryStatus = 429;
      trackEvent({ eventType: 'PAGE_VIEW', targetId: '/docs/ch1', immediate: true });
      await new Promise((r) => setTimeout(r, 40));
      expect(telemetryBodies).toHaveLength(2);

      trackEvent({ eventType: 'PAGE_VIEW', targetId: '/docs/ch2', immediate: true });
      await new Promise((r) => setTimeout(r, 40));
      expect(telemetryBodies).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
