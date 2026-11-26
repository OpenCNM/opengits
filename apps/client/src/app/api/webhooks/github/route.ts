import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';

const seenDeliveries = new Map<string, number>();
const DELIVERY_LRU_CAP = 500;

function deliverySeen(id: string): boolean {
  if (seenDeliveries.has(id)) {
    seenDeliveries.set(id, Date.now());
    return true;
  }
  seenDeliveries.set(id, Date.now());
  if (seenDeliveries.size > DELIVERY_LRU_CAP) {
    const entries = [...seenDeliveries.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of entries.slice(0, DELIVERY_LRU_CAP / 2)) seenDeliveries.delete(k);
  }
  return false;
}

function verifySignature(secret: string, body: string, signatureHeader: string | null): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export async function POST(req: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'webhook disabled (GITHUB_WEBHOOK_SECRET not set)' }, { status: 503 });
  }

  const body = await req.text();
  if (!verifySignature(secret, body, req.headers.get('x-hub-signature-256'))) {
    console.warn('[GithubWebhook] signature verification failed');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const deliveryId = req.headers.get('x-github-delivery') || '';
  if (deliveryId && deliverySeen(deliveryId)) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  let event: string = req.headers.get('x-github-event') || '';
  let payload: {
    ref?: string;
    after?: string;
    repository?: { full_name?: string; owner?: { name?: string; login?: string }; name?: string };
  };
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (event === 'ping') {
    return NextResponse.json({ ok: true, pong: true });
  }
  if (event !== 'push') {
    return NextResponse.json({ ok: true, ignored: event });
  }

  const fullName = (payload.repository?.full_name || '').toLowerCase();
  const owner = fullName.split('/')[0] || (payload.repository?.owner?.login || payload.repository?.owner?.name || '').toLowerCase();
  const repoName = (payload.repository?.name || fullName.split('/')[1] || '').toLowerCase();
  const ref = payload.ref || '';
  const afterSha = payload.after || '';
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';

  if (!owner || !repoName || !branch || !/^[0-9a-f]{40}$/i.test(afterSha)) {
    return NextResponse.json({ ok: true, skipped: 'unusable push payload' });
  }

  const rows = await prisma.repository.findMany({
    where: {
      owner: { equals: owner, mode: 'insensitive' },
      repo: { equals: repoName, mode: 'insensitive' },
      branch,
    },
    select: { id: true, gitSha: true },
  });

  if (rows.length > 0) {
    const needsUpdateIds = rows.filter((r) => !!r.gitSha && r.gitSha !== afterSha).map((r) => r.id);
    const noUpdateIds = rows.filter((r) => !r.gitSha || r.gitSha === afterSha).map((r) => r.id);

    if (needsUpdateIds.length > 0) {
      await callSidecar(
        '/v1/repos/batch-patch',
        {
          ids: needsUpdateIds,
          hasUpstreamUpdate: true,
          touchUpstreamCheckedAt: true,
          clearUpstreamEtag: true,
        },
        { label: 'github-webhook-repo-batch-update' }
      );
    }
    if (noUpdateIds.length > 0) {
      await callSidecar(
        '/v1/repos/batch-patch',
        {
          ids: noUpdateIds,
          hasUpstreamUpdate: false,
          touchUpstreamCheckedAt: true,
          clearUpstreamEtag: true,
        },
        { label: 'github-webhook-repo-batch-noupdate' }
      );
    }
  }

  console.log(
    `[GithubWebhook] push ${owner}/${repoName}@${branch} → ${afterSha.slice(0, 7)}; rows updated=${rows.length}`,
  );

  return NextResponse.json({ ok: true, updated: rows.length, sha: afterSha.slice(0, 7) });
}
