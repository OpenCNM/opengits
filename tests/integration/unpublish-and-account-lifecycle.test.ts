import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';
import { hashApiToken } from '@/lib/mcp/token-auth';
import { unpublishRepository } from '@/lib/review/unpublish-repository';
import { DELETE as accountDelete } from '@/app/api/account/delete/route';
import { DELETE as reposDelete } from '@/app/api/repos/route';
import { GET as userPublicationsGet } from '@/app/api/user/publications/route';
import { deleteRepositoryForUser } from '@/lib/repo-delete-auth';
import { listUserPublications } from '@/lib/review/user-publications';
import { HAS_SIDECAR, HAS_TEST_DB, createTestUser, uniqueTestTag } from './_test-env';

/**
 * Unpublish Vesting Cancellation & Account Deletion Cascade Integration Suite.
 * Zero vi.mock() — tests real DB + real Go Sidecar transactions.
 */

describe.skipIf(!HAS_TEST_DB || !HAS_SIDECAR)(
  'Unpublish Repository & Account Deletion Cascade Lifecycle',
  () => {
    const createdUserIds: string[] = [];
    const createdRepoIds: string[] = [];
    const createdAdminEmails: string[] = [];

    afterAll(async () => {
      if (createdRepoIds.length > 0) {
        await prisma.pendingCreditGrant.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.importRecord.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.savedRepo.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.document.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.repository.deleteMany({ where: { id: { in: createdRepoIds } } }).catch(() => {});
      }
      if (createdAdminEmails.length > 0) {
        await prisma.adminUser.deleteMany({ where: { email: { in: createdAdminEmails } } }).catch(() => {});
      }
      if (createdUserIds.length > 0) {
        await prisma.mcpApiToken.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
      }
    });

    it('enforces unpublish auth guard, cancels unvested PendingCreditGrant, detaches SavedRepo.autoFollow & blocks repeat unpublish', async () => {
      const creator = await createTestUser('unpub-creator');
      const stranger = await createTestUser('unpub-stranger');
      const reader = await createTestUser('unpub-reader');
      createdUserIds.push(creator.id, stranger.id, reader.id);

      const repo = await prisma.repository.create({
        data: {
          owner: uniqueTestTag('unpub-owner'),
          repo: uniqueTestTag('unpub-repo'),
          branch: ENGINE_CONFIG.defaultBranch,
          isPublic: true,
          reviewStatus: 'APPROVED',
          publishedAt: new Date(),
          reviewPipeline: { publication: { userId: creator.id, contentHash: 'it-pub-hash' } },
        },
      });
      createdRepoIds.push(repo.id);

      const pendingGrant = await prisma.pendingCreditGrant.create({
        data: {
          userId: creator.id,
          repositoryId: repo.id,
          amount: 50,
          status: 'PENDING',
          unlockAt: new Date(Date.now() + 7 * 86_400_000),
        },
      });

      const saved = await prisma.savedRepo.create({
        data: {
          userId: reader.id,
          repositoryId: repo.id,
          autoFollow: true,
        },
      });

      // Stranger cannot unpublish -> 403 ApiError
      const strangerErr = await unpublishRepository(stranger.id, { repoId: repo.id }).catch((e) => e);
      expect(strangerErr).toBeInstanceOf(ApiError);
      expect((strangerErr as ApiError).status).toBe(403);

      // Creator unpublishes -> real sidecar /v1/repos/unpublish & /v1/repos/patch
      const result = await unpublishRepository(creator.id, { repoId: repo.id });
      expect(result).toMatchObject({
        success: true,
        isPublic: false,
        cancelledPendingGrantsCount: 1,
        detachedSavedReposCount: 1,
      });

      const freshRepo = await prisma.repository.findUnique({ where: { id: repo.id } });
      const freshGrant = await prisma.pendingCreditGrant.findUnique({ where: { id: pendingGrant.id } });
      const freshSaved = await prisma.savedRepo.findUnique({ where: { id: saved.id } });

      expect(freshRepo?.isPublic).toBe(false);
      expect(freshGrant?.status).toBe('CANCELLED');
      expect(freshSaved?.autoFollow).toBe(false);

      // Repeat unpublish on now-private repo -> 400 ApiError
      const repeatErr = await unpublishRepository(creator.id, { repoId: repo.id }).catch((e) => e);
      expect(repeatErr).toBeInstanceOf(ApiError);
      expect((repeatErr as ApiError).status).toBe(400);
    });

    it('rejects unauthenticated DELETE /api/account/delete (401) and cascades private user data via /v1/user/delete while preserving public shared docs', async () => {
      const unauthRes = await accountDelete(
        new NextRequest('http://localhost:3000/api/account/delete', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: 'DELETE' }),
        }),
        { params: Promise.resolve({}) }
      );
      expect(unauthRes.status).toBe(401);
      expect(await unauthRes.json()).toMatchObject({ success: false, code: 'UNAUTHORIZED' });

      const doomed = await createTestUser('doomed-u');
      createdUserIds.push(doomed.id);
      const doomedEmail = doomed.email!;
      createdAdminEmails.push(doomedEmail);

      await prisma.adminUser.create({
        data: {
          email: doomedEmail,
          name: 'Doomed Admin',
          role: 'MAINTAINER',
          isActive: true,
        },
      });

      const publicRepo = await prisma.repository.create({
        data: {
          owner: uniqueTestTag('acc-pub-owner'),
          repo: uniqueTestTag('acc-pub-repo'),
          branch: ENGINE_CONFIG.defaultBranch,
          isPublic: true,
        },
      });
      createdRepoIds.push(publicRepo.id);

      const rawToken = `opgts_doomed_${randomBytes(8).toString('hex')}`;
      const mcpToken = await prisma.mcpApiToken.create({
        data: {
          userId: doomed.id,
          name: 'Doomed Token',
          tokenHash: hashApiToken(rawToken),
          prefix: rawToken.slice(0, 8),
        },
      });
      const saved = await prisma.savedRepo.create({
        data: { userId: doomed.id, repositoryId: publicRepo.id },
      });
      const privateDoc = await prisma.document.create({
        data: {
          repositoryId: publicRepo.id,
          ownerUserId: doomed.id,
          path: 'private-note.md',
          status: 'PROCESSED',
          content: 'user private content',
        },
      });
      const sharedDoc = await prisma.document.create({
        data: {
          repositoryId: publicRepo.id,
          ownerUserId: null,
          path: 'public-guide.md',
          status: 'PROCESSED',
          content: 'public shared content',
        },
      });

      // Mirror route's AdminUser deactivation + sidecar /v1/user/delete physical cascade
      await prisma.adminUser.updateMany({ where: { email: doomedEmail }, data: { isActive: false } });
      await callSidecar('/v1/user/delete', { id: doomed.id }, { label: 'account-delete' });

      expect(await prisma.user.findUnique({ where: { id: doomed.id } })).toBeNull();
      expect(await prisma.mcpApiToken.findUnique({ where: { id: mcpToken.id } })).toBeNull();
      expect(await prisma.savedRepo.findUnique({ where: { id: saved.id } })).toBeNull();
      expect(await prisma.document.findUnique({ where: { id: privateDoc.id } })).toBeNull();

      const adminAfter = await prisma.adminUser.findUnique({ where: { email: doomedEmail } });
      expect(adminAfter?.isActive).toBe(false);

      // Shared public repository & shared document survive intact
      expect(await prisma.repository.findUnique({ where: { id: publicRepo.id } })).not.toBeNull();
      expect(await prisma.document.findUnique({ where: { id: sharedDoc.id } })).not.toBeNull();
    });

    it('isolates edition deletion (draft/rejected/withdrawn), blocks PENDING & external snapshots, and scopes reader shelf removal', async () => {
      // Unauthenticated HTTP route guards -> 401 UNAUTHORIZED
      const unauthDel = await reposDelete(
        new NextRequest('http://localhost:3000/api/repos?id=nonexistent', { method: 'DELETE' }),
        { params: Promise.resolve({}) }
      );
      expect(unauthDel.status).toBe(401);
      expect(await unauthDel.json()).toMatchObject({ success: false, code: 'UNAUTHORIZED' });

      const unauthPubs = await userPublicationsGet(
        new NextRequest('http://localhost:3000/api/user/publications', { method: 'GET' }),
        { params: Promise.resolve({}) }
      );
      expect(unauthPubs.status).toBe(401);
      expect(await unauthPubs.json()).toMatchObject({ success: false, code: 'UNAUTHORIZED' });

      const maintainer = await createTestUser('del-maint');
      const reader = await createTestUser('del-reader');
      createdUserIds.push(maintainer.id, reader.id);

      const owner = uniqueTestTag('del-owner');
      const repoName = uniqueTestTag('del-repo');

      const [pubEdition, draftEdition, rejEdition, pendEdition, unpubEdition] = await Promise.all([
        prisma.repository.create({
          data: {
            owner,
            repo: repoName,
            branch: ENGINE_CONFIG.defaultBranch,
            edition: '',
            isPublic: true,
            reviewStatus: 'APPROVED',
            publishedAt: new Date(),
          },
        }),
        prisma.repository.create({
          data: {
            owner,
            repo: repoName,
            branch: ENGINE_CONFIG.defaultBranch,
            edition: 'ed_draft',
            isPublic: false,
            reviewStatus: 'NONE',
          },
        }),
        prisma.repository.create({
          data: {
            owner,
            repo: repoName,
            branch: ENGINE_CONFIG.defaultBranch,
            edition: 'ed_rej',
            isPublic: false,
            reviewStatus: 'REJECTED',
            rejectionReason: 'missing overview',
          },
        }),
        prisma.repository.create({
          data: {
            owner,
            repo: repoName,
            branch: ENGINE_CONFIG.defaultBranch,
            edition: 'ed_pend',
            isPublic: false,
            reviewStatus: 'PENDING',
          },
        }),
        prisma.repository.create({
          data: {
            owner,
            repo: repoName,
            branch: ENGINE_CONFIG.defaultBranch,
            edition: 'ed_unpub',
            isPublic: false,
            reviewStatus: 'APPROVED',
          },
        }),
      ]);
      createdRepoIds.push(pubEdition.id, draftEdition.id, rejEdition.id, pendEdition.id, unpubEdition.id);

      await Promise.all([
        prisma.importRecord.createMany({
          data: [
            { userId: maintainer.id, repositoryId: pubEdition.id, owner, repo: repoName, branch: ENGINE_CONFIG.defaultBranch, sha: 'sha1' },
            { userId: maintainer.id, repositoryId: draftEdition.id, owner, repo: repoName, branch: ENGINE_CONFIG.defaultBranch, sha: 'sha2' },
            { userId: maintainer.id, repositoryId: rejEdition.id, owner, repo: repoName, branch: ENGINE_CONFIG.defaultBranch, sha: 'sha3' },
            { userId: maintainer.id, repositoryId: pendEdition.id, owner, repo: repoName, branch: ENGINE_CONFIG.defaultBranch, sha: 'sha4' },
            { userId: maintainer.id, repositoryId: unpubEdition.id, owner, repo: repoName, branch: ENGINE_CONFIG.defaultBranch, sha: 'sha5' },
          ],
        }),
        prisma.document.createMany({
          data: [
            { repositoryId: draftEdition.id, ownerUserId: maintainer.id, path: 'draft.md', status: 'PROCESSED', content: 'draft' },
            { repositoryId: rejEdition.id, ownerUserId: maintainer.id, path: 'rej.md', status: 'PROCESSED', content: 'rejected' },
          ],
        }),
        prisma.savedRepo.create({
          data: { userId: reader.id, repositoryId: unpubEdition.id, autoFollow: false, paidCredits: 10 },
        }),
      ]);

      // 1) Publications API projection reflects deletability and external-user protection
      const initialPubs = await listUserPublications(maintainer.id);
      const byId = new Map(initialPubs.map((p) => [p.id, p]));
      expect(byId.get(draftEdition.id)).toMatchObject({ canDelete: true, hasExternalUsers: false });
      expect(byId.get(rejEdition.id)).toMatchObject({ canDelete: true, hasExternalUsers: false });
      expect(byId.get(pubEdition.id)).toMatchObject({ canDelete: false, hasExternalUsers: false });
      expect(byId.get(pendEdition.id)).toMatchObject({ canDelete: false, hasExternalUsers: false });
      expect(byId.get(unpubEdition.id)).toMatchObject({ canDelete: false, hasExternalUsers: true });

      // 2) Draft & rejected editions delete cleanly without touching sibling public edition
      const delDraft = await deleteRepositoryForUser(maintainer.id, { id: draftEdition.id, globalDelete: true });
      const delRej = await deleteRepositoryForUser(maintainer.id, { id: rejEdition.id, globalDelete: true });
      expect(delDraft.action).toBe('GLOBAL_DELETE');
      expect(delRej.action).toBe('GLOBAL_DELETE');
      expect(await prisma.repository.findUnique({ where: { id: draftEdition.id } })).toBeNull();
      expect(await prisma.repository.findUnique({ where: { id: rejEdition.id } })).toBeNull();
      expect(await prisma.repository.findUnique({ where: { id: pubEdition.id } })).not.toBeNull();

      // 3) PENDING review cannot be deleted until withdrawn (reviewStatus='NONE')
      const pendErr = await deleteRepositoryForUser(maintainer.id, { id: pendEdition.id, globalDelete: true }).catch((e) => e);
      expect(pendErr).toBeInstanceOf(ApiError);
      expect((pendErr as ApiError).status).toBe(409);

      await prisma.repository.update({
        where: { id: pendEdition.id },
        data: { reviewStatus: 'NONE' },
      });
      const delWithdrawn = await deleteRepositoryForUser(maintainer.id, { id: pendEdition.id, globalDelete: true });
      expect(delWithdrawn.action).toBe('GLOBAL_DELETE');
      expect(await prisma.repository.findUnique({ where: { id: pendEdition.id } })).toBeNull();

      // 4) Unpublished edition with reader snapshot blocks maintainer global delete (409)
      const extErr = await deleteRepositoryForUser(maintainer.id, { id: unpubEdition.id, globalDelete: true }).catch((e) => e);
      expect(extErr).toBeInstanceOf(ApiError);
      expect((extErr as ApiError).status).toBe(409);

      // Reader with globalDelete=true is forbidden (403)
      const readerGlobalErr = await deleteRepositoryForUser(reader.id, { id: unpubEdition.id, globalDelete: true }).catch((e) => e);
      expect(readerGlobalErr).toBeInstanceOf(ApiError);
      expect((readerGlobalErr as ApiError).status).toBe(403);

      // Reader without globalDelete only detaches own SavedRepo snapshot; repo remains intact
      const readerUnsave = await deleteRepositoryForUser(reader.id, { id: unpubEdition.id, globalDelete: false });
      expect(readerUnsave.action).toBe('PERSONAL_UNSAVE');
      expect(await prisma.savedRepo.findUnique({ where: { userId_repositoryId: { userId: reader.id, repositoryId: unpubEdition.id } } })).toBeNull();
      expect(await prisma.repository.findUnique({ where: { id: unpubEdition.id } })).not.toBeNull();

      // Once external snapshots are gone, maintainer can cleanly delete the unpublished edition
      const afterUnsavePubs = await listUserPublications(maintainer.id);
      expect(afterUnsavePubs.find((p) => p.id === unpubEdition.id)).toMatchObject({
        hasExternalUsers: false,
        canDelete: true,
      });
      const delUnpub = await deleteRepositoryForUser(maintainer.id, { id: unpubEdition.id, globalDelete: true });
      expect(delUnpub.action).toBe('GLOBAL_DELETE');
      expect(await prisma.repository.findUnique({ where: { id: unpubEdition.id } })).toBeNull();
    });
  }
);
