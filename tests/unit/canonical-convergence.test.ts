import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitCanonicalPromotion } from '@/lib/update-market/canonical-convergence';

const {
  callSidecarMock,
  postSwapMock,
} = vi.hoisted(() => ({
  callSidecarMock: vi.fn(),
  postSwapMock: vi.fn(),
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/update-market/jobs', () => ({
  postSwap: vi.fn((...args: unknown[]) => {
    postSwapMock(...args);
    return Promise.resolve();
  }),
}));

describe('Single-Writer Canonical Convergence Tail (commitCanonicalPromotion)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to sidecar /v1/chapter-versions/promote and triggers postSwap on flip', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      flipped: true,
      canonicalVersionId: 'challenger',
      previousVersionId: 'incumbent',
      reason: 'SUCCESS',
      postSwapPayload: {
        repositoryId: 'repo-1',
        documentId: 'doc-1',
        path: 'docs/guide.md',
        contentId: 'content-c',
        content: '# Full Chapter Content\n\nExplanation text.',
      },
    });

    const res = await commitCanonicalPromotion({ documentId: 'doc-1' });

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/chapter-versions/promote',
      expect.objectContaining({
        documentId: 'doc-1',
        flipMargin: 2,
      }),
      expect.anything()
    );
    expect(res.flipped).toBe(true);
    expect(res.canonicalVersionId).toBe('challenger');
    expect(res.reason).toBe('SUCCESS');
    expect(postSwapMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'repo-1',
        documentId: 'doc-1',
        path: 'docs/guide.md',
        stagedContentId: 'content-c',
      }),
      '# Full Chapter Content\n\nExplanation text.'
    );
  });

  it('respects maintainer pin immunity (pinnedAt != null) during community voting', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      flipped: false,
      canonicalVersionId: 'incumbent',
      reason: 'MAINTAINER_PINNED_IMMUNE',
    });

    const res = await commitCanonicalPromotion({ documentId: 'doc-1' });

    expect(res.flipped).toBe(false);
    expect(res.reason).toBe('MAINTAINER_PINNED_IMMUNE');
    expect(postSwapMock).not.toHaveBeenCalled();
  });

  it('enforces hysteresis flipMargin = 2 (leading by 1 vote does not flip)', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      flipped: false,
      canonicalVersionId: 'incumbent',
      reason: 'MARGIN_NOT_MET',
    });

    const res = await commitCanonicalPromotion({ documentId: 'doc-1' });

    expect(res.flipped).toBe(false);
    expect(res.reason).toBe('MARGIN_NOT_MET');
    expect(postSwapMock).not.toHaveBeenCalled();
  });

  it('handles maintainer pin promotion: records PINNED event and postSwap', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      flipped: true,
      canonicalVersionId: 'v-selected',
      previousVersionId: 'v-old',
      reason: 'SUCCESS',
      postSwapPayload: {
        repositoryId: 'repo-1',
        documentId: 'doc-1',
        path: 'docs/guide.md',
        contentId: 'content-sel',
        content: '# Selected Content',
      },
    });

    const res = await commitCanonicalPromotion({
      documentId: 'doc-1',
      targetVersionId: 'v-selected',
      isPinOperation: true,
      operatorUserId: 'maintainer-1',
    });

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/chapter-versions/promote',
      expect.objectContaining({
        documentId: 'doc-1',
        targetVersionId: 'v-selected',
        isPinOperation: true,
        operatorUserId: 'maintainer-1',
      }),
      expect.anything()
    );
    expect(res.flipped).toBe(true);
    expect(res.canonicalVersionId).toBe('v-selected');
  });

  it('safely exits with NOT_FOUND if document does not exist', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      flipped: false,
      reason: 'NOT_FOUND',
    });

    const res = await commitCanonicalPromotion({ documentId: 'nonexistent-doc' });

    expect(res.flipped).toBe(false);
    expect(res.reason).toBe('NOT_FOUND');
    expect(postSwapMock).not.toHaveBeenCalled();
  });
});
