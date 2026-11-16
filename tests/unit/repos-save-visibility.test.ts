import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = {
  repository: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
};

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

const getSessionHelperMock = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: (...args: unknown[]) => getSessionHelperMock(...args),
}));

const isShelfFeeExemptMock = vi.fn();
const chargeShelfFeeAndSaveMock = vi.fn();
vi.mock('@/lib/credits/shelf-fee', () => ({
  isShelfFeeExempt: (...args: unknown[]) => isShelfFeeExemptMock(...args),
  chargeShelfFeeAndSave: (...args: unknown[]) => chargeShelfFeeAndSaveMock(...args),
}));

vi.mock('@/lib/docs/web-outline-projection', () => ({
  invalidateWebL1Projection: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

describe('POST /api/repos - S1 isPublic Gate & Shelf Exemption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'user-attacker', role: 'USER' },
    });
    chargeShelfFeeAndSaveMock.mockResolvedValue({
      ok: true,
      fee: 0,
      alreadySaved: false,
      signupGift: 0,
    });
  });

  async function callPost(body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/repos/route');
    const request = new NextRequest('http://localhost/api/repos', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    return POST(request);
  }

  it('按 owner/repo 解析时仅匹配 isPublic=true 仓库（防私仓信息泄露）', async () => {
    prismaMock.repository.findFirst.mockResolvedValue(null);

    const res = await callPost({
      action: 'save',
      owner: 'victim',
      repo: 'private-course',
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Repository ID is required');
    expect(prismaMock.repository.findFirst).toHaveBeenCalledWith({
      where: { owner: 'victim', repo: 'private-course', isPublic: true },
      select: { id: true },
    });
  });

  it('针对私有/下架仓库，非豁免用户保存返回 403 拒绝', async () => {
    prismaMock.repository.findUnique.mockResolvedValue({
      id: 'repo-private-1',
      owner: 'victim',
      repo: 'secret-course',
      isPublic: false,
    });
    isShelfFeeExemptMock.mockResolvedValue(false);

    const res = await callPost({
      action: 'save',
      repositoryId: 'repo-private-1',
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain('私有或已下架教程不可收藏');
    expect(chargeShelfFeeAndSaveMock).not.toHaveBeenCalled();
  });

  it('针对私有仓库，导入者或贡献者（豁免用户）允许保存', async () => {
    prismaMock.repository.findUnique.mockResolvedValue({
      id: 'repo-private-1',
      owner: 'victim',
      repo: 'secret-course',
      isPublic: false,
    });
    isShelfFeeExemptMock.mockResolvedValue(true);

    const res = await callPost({
      action: 'save',
      repositoryId: 'repo-private-1',
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(chargeShelfFeeAndSaveMock).toHaveBeenCalledWith('user-attacker', 'repo-private-1', true);
  });

  it('针对公开仓库，任何登录用户均可进入收藏与扣费流', async () => {
    prismaMock.repository.findUnique.mockResolvedValue({
      id: 'repo-pub-1',
      owner: 'octo',
      repo: 'open-course',
      isPublic: true,
    });

    const res = await callPost({
      action: 'save',
      repositoryId: 'repo-pub-1',
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(chargeShelfFeeAndSaveMock).toHaveBeenCalledWith('user-attacker', 'repo-pub-1', true);
  });
});
