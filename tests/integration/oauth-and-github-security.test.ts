import http from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { POST as registerPost } from '@/app/api/auth/oauth/register/route';
import { GET as authorizeGet, consumeAuthCode } from '@/app/api/auth/oauth/authorize/route';
import { POST as tokenPost } from '@/app/api/auth/oauth/token/route';
import { POST as githubWebhookPost } from '@/app/api/webhooks/github/route';
import { enforceMcpAuth } from '@/lib/mcp/request-guard';
import { hashApiToken } from '@/lib/mcp/token-auth';
import { githubFetch, GithubNetworkError } from '@/lib/github/client';
import {
  acquirePoolToken,
  clearQuarantinedForTests,
  isTokenQuarantined,
  tokenFingerprint,
} from '@/lib/github/token-pool';
import { HAS_SIDECAR, HAS_TEST_DB, createTestUser, uniqueTestTag } from './_test-env';

/**
 * OAuth 2.1 DCR / PKCE Security & GitHub Webhook / Token-Pool Integration Suite.
 * Zero vi.mock(), zero fetch stubbing — tests real DB, real Go sidecar,
 * real Next.js route handlers, and real ephemeral node:http endpoints.
 */

function pkceChallenge(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signGithubPayload(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe.skipIf(!HAS_TEST_DB || !HAS_SIDECAR)(
  'OAuth 2.1 DCR, Authorize Pre-Session Guards, PKCE Exchange & Replay Defense',
  () => {
    const createdClientIds: string[] = [];
    const createdUserIds: string[] = [];
    const createdCodes: string[] = [];

    afterAll(async () => {
      if (createdCodes.length > 0) {
        await prisma.oAuthAuthCode.deleteMany({ where: { code: { in: createdCodes } } }).catch(() => {});
      }
      if (createdClientIds.length > 0) {
        await prisma.oAuthAuthCode.deleteMany({ where: { clientId: { in: createdClientIds } } }).catch(() => {});
        await prisma.oAuthClient.deleteMany({ where: { id: { in: createdClientIds } } }).catch(() => {});
      }
      if (createdUserIds.length > 0) {
        await prisma.mcpApiToken.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
      }
    });

    it('DCR registerPost persists valid client, rejects insecure/missing redirect_uris & rate-limits 11th request', async () => {
      const testIp = `203.0.113.${Math.floor(Math.random() * 200) + 10}`;

      // Missing redirect_uris -> 400
      const missingRes = await registerPost(
        new NextRequest('http://localhost:3000/api/auth/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
          body: JSON.stringify({ client_name: 'bad-missing' }),
        })
      );
      expect(missingRes.status).toBe(400);

      // Insecure non-loopback http:// redirect_uri -> 400
      const insecureRes = await registerPost(
        new NextRequest('http://localhost:3000/api/auth/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
          body: JSON.stringify({ client_name: 'bad-http', redirect_uris: ['http://evil.com/cb'] }),
        })
      );
      expect(insecureRes.status).toBe(400);

      // Valid DCR registration -> 201 + DB row persisted (consumes slot 3 of 10)
      const okRes = await registerPost(
        new NextRequest('http://localhost:3000/api/auth/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
          body: JSON.stringify({
            client_name: 'it-mcp-agent',
            redirect_uris: ['http://127.0.0.1:4312/callback'],
          }),
        })
      );
      expect(okRes.status).toBe(201);
      const okJson = (await okRes.json()) as { client_id: string; redirect_uris: string[] };
      expect(okJson.client_id).toMatch(/^opgts-client-/);
      createdClientIds.push(okJson.client_id);

      const dbClient = await prisma.oAuthClient.findUnique({ where: { id: okJson.client_id } });
      expect(dbClient?.redirectUris).toEqual(['http://127.0.0.1:4312/callback']);

      // Exhaust remaining 7 slots (4..10) with invalid JSON/payload -> 400; 11th -> 429
      for (let i = 4; i <= 10; i++) {
        const r = await registerPost(
          new NextRequest('http://localhost:3000/api/auth/oauth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
            body: JSON.stringify({ client_name: `probe-${i}` }),
          })
        );
        expect(r.status).toBe(400);
      }
      const rateLimitedRes = await registerPost(
        new NextRequest('http://localhost:3000/api/auth/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
          body: JSON.stringify({ client_name: 'rate-limited', redirect_uris: ['http://127.0.0.1:4312/callback'] }),
        })
      );
      expect(rateLimitedRes.status).toBe(429);
    });

    it('authorizeGet enforces S256, client_id, redirect_uri whitelist, RFC 8707 resource & signin redirect', async () => {
      const client = await prisma.oAuthClient.create({
        data: {
          id: uniqueTestTag('opgts-auth'),
          name: 'Auth Guard Client',
          redirectUris: ['http://127.0.0.1:5123/cb'],
        },
      });
      createdClientIds.push(client.id);

      // Missing S256 -> 400 invalid_request
      const badMethod = await authorizeGet(
        new NextRequest(
          `http://localhost:3000/api/auth/oauth/authorize?client_id=${client.id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:5123/cb')}&code_challenge=abc&code_challenge_method=plain`
        )
      );
      expect(badMethod.status).toBe(400);
      expect(await badMethod.json()).toMatchObject({ error: 'invalid_request' });

      // Unknown client_id -> 400 unauthorized_client
      const unknownClient = await authorizeGet(
        new NextRequest(
          `http://localhost:3000/api/auth/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent('http://127.0.0.1:5123/cb')}&code_challenge=abc&code_challenge_method=S256`
        )
      );
      expect(unknownClient.status).toBe(400);
      expect(await unknownClient.json()).toMatchObject({ error: 'unauthorized_client' });

      // Non-whitelisted redirect_uri -> 400 invalid_request
      const badRedirect = await authorizeGet(
        new NextRequest(
          `http://localhost:3000/api/auth/oauth/authorize?client_id=${client.id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=abc&code_challenge_method=S256`
        )
      );
      expect(badRedirect.status).toBe(400);
      expect(await badRedirect.json()).toMatchObject({ error: 'invalid_request' });

      // Cross-origin RFC 8707 resource -> 307 redirect to redirect_uri with error=invalid_target
      const crossResource = await authorizeGet(
        new NextRequest(
          `http://localhost:3000/api/auth/oauth/authorize?client_id=${client.id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:5123/cb')}&code_challenge=abc&code_challenge_method=S256&state=st1&resource=${encodeURIComponent('https://evil.example/mcp')}`
        )
      );
      expect(crossResource.status).toBe(307);
      const errLoc = new URL(crossResource.headers.get('location')!);
      expect(errLoc.origin).toBe('http://127.0.0.1:5123');
      expect(errLoc.searchParams.get('error')).toBe('invalid_target');
      expect(errLoc.searchParams.get('state')).toBe('st1');

      // Valid params with no session -> 307 redirect to /auth/signin?callbackUrl=...
      const noSession = await authorizeGet(
        new NextRequest(
          `http://localhost:3000/api/auth/oauth/authorize?client_id=${client.id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:5123/cb')}&code_challenge=abc&code_challenge_method=S256`
        )
      );
      expect(noSession.status).toBe(307);
      const loginLoc = new URL(noSession.headers.get('location')!);
      expect(loginLoc.pathname).toBe('/auth/signin');
      expect(loginLoc.searchParams.get('callbackUrl')).toContain('/api/auth/oauth/authorize');
    });

    it('tokenPost enforces PKCE S256, client/redirect/expiry guards, 4-way replay defense & 20-token self-heal cap', async () => {
      const user = await createTestUser('oauth-u');
      createdUserIds.push(user.id);

      const client = await prisma.oAuthClient.create({
        data: {
          id: uniqueTestTag('opgts-tok'),
          name: 'Token Client',
          redirectUris: ['http://127.0.0.1:6100/cb'],
        },
      });
      createdClientIds.push(client.id);

      const verifier = 'verifier-' + randomBytes(16).toString('hex');
      const challenge = pkceChallenge(verifier);
      const redirectUri = 'http://127.0.0.1:6100/cb';

      const seedCode = async (overrides: Partial<{ expiresAt: Date; codeChallenge: string; clientId: string; redirectUri: string }> = {}) => {
        const code = uniqueTestTag('code');
        createdCodes.push(code);
        await prisma.oAuthAuthCode.create({
          data: {
            code,
            clientId: overrides.clientId ?? client.id,
            userId: user.id,
            codeChallenge: overrides.codeChallenge ?? challenge,
            redirectUri: overrides.redirectUri ?? redirectUri,
            expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
          },
        });
        return code;
      };

      const postToken = (body: Record<string, string>) =>
        tokenPost(
          new NextRequest('http://localhost:3000/api/auth/oauth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        );

      // 1. Wrong code_verifier -> 400 invalid_grant
      const codeWrongVerifier = await seedCode();
      const resWrongVer = await postToken({
        grant_type: 'authorization_code',
        code: codeWrongVerifier,
        code_verifier: 'wrong-verifier',
        client_id: client.id,
        redirect_uri: redirectUri,
      });
      expect(resWrongVer.status).toBe(400);
      expect(await resWrongVer.json()).toMatchObject({ error: 'invalid_grant' });

      // 2. Mismatched client_id -> 400 invalid_grant
      const codeBadClient = await seedCode();
      const resBadClient = await postToken({
        grant_type: 'authorization_code',
        code: codeBadClient,
        code_verifier: verifier,
        client_id: 'other-client',
        redirect_uri: redirectUri,
      });
      expect(resBadClient.status).toBe(400);
      expect(await resBadClient.json()).toMatchObject({ error: 'invalid_grant' });

      // 3. Mismatched redirect_uri -> 400 invalid_grant
      const codeBadRedirect = await seedCode();
      const resBadRedirect = await postToken({
        grant_type: 'authorization_code',
        code: codeBadRedirect,
        code_verifier: verifier,
        client_id: client.id,
        redirect_uri: 'http://127.0.0.1:6100/other',
      });
      expect(resBadRedirect.status).toBe(400);
      expect(await resBadRedirect.json()).toMatchObject({ error: 'invalid_grant' });

      // 4. Expired code -> 400 invalid_grant
      const codeExpired = await seedCode({ expiresAt: new Date(Date.now() - 5_000) });
      const resExpired = await postToken({
        grant_type: 'authorization_code',
        code: codeExpired,
        code_verifier: verifier,
        client_id: client.id,
        redirect_uri: redirectUri,
      });
      expect(resExpired.status).toBe(400);
      expect(await resExpired.json()).toMatchObject({ error: 'invalid_grant' });
      expect(await consumeAuthCode(codeExpired, verifier)).toBeNull();

      // 5. Concurrent 4-way replay/double-redeem -> 1x 200 Bearer + 3x 400 invalid_grant
      const raceCode = await seedCode();
      const raceResponses = await Promise.all(
        Array.from({ length: 4 }, () =>
          postToken({
            grant_type: 'authorization_code',
            code: raceCode,
            code_verifier: verifier,
            client_id: client.id,
            redirect_uri: redirectUri,
          })
        )
      );
      const okResponses = raceResponses.filter((r) => r.status === 200);
      const errResponses = raceResponses.filter((r) => r.status === 400);
      expect(okResponses).toHaveLength(1);
      expect(errResponses).toHaveLength(3);

      const issued = (await okResponses[0].json()) as { access_token: string; token_type: string };
      expect(issued.token_type).toBe('Bearer');
      expect(issued.access_token).toMatch(/^opgts_/);

      // Issued token passes real MCP auth guard
      const authCheck = await enforceMcpAuth(
        new NextRequest('http://localhost:3000/api/mcp/hub', {
          headers: { authorization: `Bearer ${issued.access_token}` },
        })
      );
      expect(authCheck.response).toBeNull();
      expect(authCheck.userId).toBe(user.id);

      // 6. 20-token self-heal cap: seed 19 more active tokens (total 20) -> redeem triggers sidecar revoke
      const tokenName = `OAuth:${client.id}`.slice(0, 50);
      for (let i = 0; i < 19; i++) {
        const raw = `opgts_seed_${i}_${randomBytes(8).toString('hex')}`;
        await prisma.mcpApiToken.create({
          data: {
            userId: user.id,
            name: i === 0 ? tokenName : `extra-${i}`,
            tokenHash: hashApiToken(raw),
            prefix: raw.slice(0, 8),
          },
        });
      }

      const capCode = await seedCode();
      const capRes = await postToken({
        grant_type: 'authorization_code',
        code: capCode,
        code_verifier: verifier,
        client_id: client.id,
        redirect_uri: redirectUri,
      });
      expect(capRes.status).toBe(200);
      const capJson = (await capRes.json()) as { access_token: string };

      const activeAfterCap = await prisma.mcpApiToken.count({
        where: { userId: user.id, revokedAt: null },
      });
      const revokedCount = await prisma.mcpApiToken.count({
        where: { userId: user.id, revokedAt: { not: null } },
      });
      expect(activeAfterCap).toBe(20);
      expect(revokedCount).toBe(1);

      const newTokenAuth = await enforceMcpAuth(
        new NextRequest('http://localhost:3000/api/mcp/hub', {
          headers: { authorization: `Bearer ${capJson.access_token}` },
        })
      );
      expect(newTokenAuth.response).toBeNull();
      expect(newTokenAuth.userId).toBe(user.id);
    });
  }
);

describe.skipIf(!HAS_TEST_DB || !HAS_SIDECAR)(
  'GitHub Push Webhook HMAC & Delivery LRU',
  () => {
    const createdRepoIds: string[] = [];
    const origWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

    afterEach(() => {
      if (origWebhookSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
      else process.env.GITHUB_WEBHOOK_SECRET = origWebhookSecret;
    });

    afterAll(async () => {
      if (createdRepoIds.length > 0) {
        await prisma.repository.deleteMany({ where: { id: { in: createdRepoIds } } }).catch(() => {});
      }
    });

    it('enforces webhook secret presence (503), HMAC verification (401), ping/LRU dedup & push batch-patch', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      const disabledRes = await githubWebhookPost(
        new NextRequest('http://localhost:3000/api/webhooks/github', { method: 'POST', body: '{}' })
      );
      expect(disabledRes.status).toBe(503);

      const secret = 'it-webhook-secret-' + randomBytes(8).toString('hex');
      process.env.GITHUB_WEBHOOK_SECRET = secret;

      const badSigRes = await githubWebhookPost(
        new NextRequest('http://localhost:3000/api/webhooks/github', {
          method: 'POST',
          headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
          body: '{"zen":"keep it logically awesome"}',
        })
      );
      expect(badSigRes.status).toBe(401);

      const pingBody = JSON.stringify({ zen: 'hello' });
      const deliveryId = uniqueTestTag('deliv');
      const pingRes = await githubWebhookPost(
        new NextRequest('http://localhost:3000/api/webhooks/github', {
          method: 'POST',
          headers: {
            'x-github-event': 'ping',
            'x-github-delivery': deliveryId,
            'x-hub-signature-256': signGithubPayload(secret, pingBody),
          },
          body: pingBody,
        })
      );
      expect(pingRes.status).toBe(200);
      expect(await pingRes.json()).toEqual({ ok: true, pong: true });

      const dupRes = await githubWebhookPost(
        new NextRequest('http://localhost:3000/api/webhooks/github', {
          method: 'POST',
          headers: {
            'x-github-event': 'ping',
            'x-github-delivery': deliveryId,
            'x-hub-signature-256': signGithubPayload(secret, pingBody),
          },
          body: pingBody,
        })
      );
      expect(dupRes.status).toBe(200);
      expect(await dupRes.json()).toEqual({ ok: true, duplicate: true });

      // Seed 2 repository rows on same owner/repo/branch (different editions): one stale, one already at afterSha
      const owner = uniqueTestTag('wh-owner').toLowerCase();
      const repoName = uniqueTestTag('wh-repo').toLowerCase();
      const oldSha = '1111111111111111111111111111111111111111';
      const afterSha = '2222222222222222222222222222222222222222';

      const staleRepo = await prisma.repository.create({
        data: {
          owner,
          repo: repoName,
          branch: ENGINE_CONFIG.defaultBranch,
          edition: '',
          gitSha: oldSha,
          hasUpstreamUpdate: false,
          upstreamEtag: '"etag-stale"',
        },
      });
      const currentRepo = await prisma.repository.create({
        data: {
          owner,
          repo: repoName,
          branch: ENGINE_CONFIG.defaultBranch,
          edition: 'deep',
          gitSha: afterSha,
          hasUpstreamUpdate: true,
          upstreamEtag: '"etag-current"',
        },
      });
      createdRepoIds.push(staleRepo.id, currentRepo.id);

      const pushBody = JSON.stringify({
        ref: `refs/heads/${ENGINE_CONFIG.defaultBranch}`,
        after: afterSha,
        repository: { full_name: `${owner}/${repoName}`, name: repoName },
      });
      const pushRes = await githubWebhookPost(
        new NextRequest('http://localhost:3000/api/webhooks/github', {
          method: 'POST',
          headers: {
            'x-github-event': 'push',
            'x-github-delivery': uniqueTestTag('push-deliv'),
            'x-hub-signature-256': signGithubPayload(secret, pushBody),
          },
          body: pushBody,
        })
      );
      expect(pushRes.status).toBe(200);
      expect(await pushRes.json()).toMatchObject({ ok: true, updated: 2, sha: afterSha.slice(0, 7) });

      const freshStale = await prisma.repository.findUnique({ where: { id: staleRepo.id } });
      const freshCurrent = await prisma.repository.findUnique({ where: { id: currentRepo.id } });
      expect(freshStale?.hasUpstreamUpdate).toBe(true);
      expect(freshStale?.upstreamEtag).toBeNull();
      expect(freshCurrent?.hasUpstreamUpdate).toBe(false);
      expect(freshCurrent?.upstreamEtag).toBeNull();
    });
  }
);

describe('githubFetch & Token Pool Rotation / Quarantine over Ephemeral node:http (Non-DB)', () => {
  const origGithubTokens = process.env.GITHUB_TOKENS;
  const origGithubToken = process.env.GITHUB_TOKEN;

  afterEach(() => {
    clearQuarantinedForTests();
    if (origGithubTokens === undefined) delete process.env.GITHUB_TOKENS;
    else process.env.GITHUB_TOKENS = origGithubTokens;
    if (origGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = origGithubToken;
  });

  it('dedups pool tokens, strips caller Auth when pool empty, rotates on 403-ratelimit/401, skips rotation on plain 403 & explicitToken, and retries ECONNRESET', async () => {
    let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
      res.writeHead(200);
      res.end('ok');
    };
    const seenAuthHeaders: Array<string | undefined> = [];

    const server = http.createServer((req, res) => {
      seenAuthHeaders.push(req.headers.authorization);
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Empty pool strips caller's legacy Authorization header
      process.env.GITHUB_TOKENS = '';
      process.env.GITHUB_TOKEN = '';
      expect(acquirePoolToken()).toBeUndefined();

      const anonRes = await githubFetch(`${baseUrl}/repos/a/b`, {
        headers: { Authorization: 'Bearer caller-secret-should-be-stripped' },
      });
      expect(anonRes.status).toBe(200);
      expect(seenAuthHeaders[0]).toBeUndefined();

      // 2. Pool dedup + round-robin (tokA, tokB)
      const tokA = 'ghp_pool_token_A_' + uniqueTestTag('a');
      const tokB = 'ghp_pool_token_B_' + uniqueTestTag('b');
      process.env.GITHUB_TOKENS = `${tokA}, ${tokB}`;
      process.env.GITHUB_TOKEN = tokA; // duplicate must be deduped

      const t1 = acquirePoolToken();
      const t2 = acquirePoolToken();
      const t3 = acquirePoolToken();
      expect(t1?.value).toBe(tokA);
      expect(t2?.value).toBe(tokB);
      expect(t3?.value).toBe(tokA); // wraps around after 2 unique tokens

      // 3. 403 WITHOUT rate-limit headers -> returns 403 WITHOUT rotating or cooling down
      seenAuthHeaders.length = 0;
      handler = (_req, res) => {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Forbidden private repo' }));
      };
      const plain403 = await githubFetch(`${baseUrl}/repos/priv/repo`);
      expect(plain403.status).toBe(403);
      expect(seenAuthHeaders).toHaveLength(1);

      // 4. 403 WITH x-ratelimit-remaining: 0 on GET -> cools down first token and rotates to second (200)
      seenAuthHeaders.length = 0;
      let calls = 0;
      handler = (_req, res) => {
        calls++;
        if (calls === 1) {
          res.writeHead(403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120),
          });
          res.end('rate limited');
          return;
        }
        res.writeHead(200);
        res.end('rotated-ok');
      };
      const rotatedRes = await githubFetch(`${baseUrl}/repos/pub/repo`);
      expect(rotatedRes.status).toBe(200);
      expect(await rotatedRes.text()).toBe('rotated-ok');
      expect(seenAuthHeaders).toHaveLength(2);
      expect(seenAuthHeaders[0]).not.toBe(seenAuthHeaders[1]);

      // 5. 401 on GET -> quarantines first token and rotates to second
      const tokC = 'ghp_pool_token_C_' + uniqueTestTag('c');
      const tokD = 'ghp_pool_token_D_' + uniqueTestTag('d');
      process.env.GITHUB_TOKENS = `${tokC}, ${tokD}`;
      process.env.GITHUB_TOKEN = '';
      seenAuthHeaders.length = 0;
      calls = 0;
      handler = (_req, res) => {
        calls++;
        if (calls === 1) {
          res.writeHead(401);
          res.end('bad credentials');
          return;
        }
        res.writeHead(200);
        res.end('after-401-rotate');
      };
      const after401 = await githubFetch(`${baseUrl}/repos/pub/repo2`);
      expect(after401.status).toBe(200);
      expect(seenAuthHeaders).toHaveLength(2);
      expect(isTokenQuarantined(tokenFingerprint(tokC))).toBe(true);
      expect(isTokenQuarantined(tokenFingerprint(tokD))).toBe(false);

      // 6. explicitToken -> NO rotation on 429
      seenAuthHeaders.length = 0;
      handler = (_req, res) => {
        res.writeHead(429, { 'retry-after': '60' });
        res.end('too many');
      };
      const expRes = await githubFetch(`${baseUrl}/repos/pub/repo3`, {}, { explicitToken: 'ghp_explicit_only' });
      expect(expRes.status).toBe(429);
      expect(seenAuthHeaders).toEqual(['Bearer ghp_explicit_only']);

      // 7. Socket reset on GET -> retries 3 attempts and rejects with GithubNetworkError
      let resetAttempts = 0;
      handler = (req) => {
        resetAttempts++;
        req.socket.destroy();
      };
      await expect(
        githubFetch(`${baseUrl}/repos/net/fail`, {}, { explicitToken: 'ghp_net_test' })
      ).rejects.toBeInstanceOf(GithubNetworkError);
      expect(resetAttempts).toBe(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
