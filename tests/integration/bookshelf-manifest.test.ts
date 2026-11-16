import { test, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { buildCapabilityManifest } from '@/lib/mcp/capability-manifest';

test('buildCapabilityManifest：公开仓清单完整（identity/contentProfile/bestUsedFor）', async () => {
  const repo = await prisma.repository.findFirst({
    where: { isPublic: true },
    select: { id: true, owner: true, repo: true },
  });
  if (!repo) {
    console.warn('  ⚠️ 库中无公开仓，跳过 manifest 断言');
    return;
  }
  const manifest = await buildCapabilityManifest(repo.id);
  expect(manifest).toBeTruthy();
  expect(manifest!.identity?.displayName).toBeTruthy();
  expect(manifest!.identity.sourceType).toMatch(/^(web|github)$/);
  expect(manifest!.identity.sourceUrl).toMatch(/^https?:\/\//);
  expect(manifest!.identity.lastSyncedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(typeof manifest!.contentProfile?.totalDocuments).toBe('number');
  expect(Array.isArray(manifest!.bestUsedFor)).toBe(true);
  expect(manifest!.bestUsedFor!.length).toBeGreaterThan(0);
});
