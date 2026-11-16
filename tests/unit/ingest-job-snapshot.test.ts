import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportJobSnapshotSchema, IMPORT_JOB_STATUS } from '@/lib/schemas/import-job';

const findUniqueMock = vi.fn();
const findManyMock = vi.fn();
const aggregateMock = vi.fn();
const countMock = vi.fn().mockResolvedValue(0);

vi.mock('@/lib/db', () => ({
  prisma: {
    importJob: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      count: (...args: unknown[]) => countMock(...args),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    importJobEvent: {
      findMany: (...args: unknown[]) => findManyMock(...args),
      aggregate: (...args: unknown[]) => aggregateMock(...args),
    },
  },
}));

describe('ImportJob Snapshot & Progress Info Schema', () => {
  it('validates snapshot with progressInfo present', () => {
    const data = {
      job: {
        id: 'job-123',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        edition: 'free',
        status: IMPORT_JOB_STATUS.RUNNING,
        error: null,
        finishedAt: null,
        lastSeq: 5,
        progressInfo: {
          step: '[3/5] 流式扫描文件树与结构嗅探...',
          progress: 40,
          updatedAt: '2026-09-21T00:00:00Z',
        },
      },
      events: [],
    };

    const parsed = ImportJobSnapshotSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.job.progressInfo).toEqual({
        step: '[3/5] 流式扫描文件树与结构嗅探...',
        progress: 40,
        updatedAt: '2026-09-21T00:00:00Z',
      });
    }
  });

  it('validates snapshot when progressInfo is null or undefined', () => {
    const dataNull = {
      job: {
        id: 'job-123',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        edition: 'free',
        status: IMPORT_JOB_STATUS.QUEUED,
        error: null,
        finishedAt: null,
        lastSeq: 0,
        progressInfo: null,
      },
      events: [],
    };
    expect(ImportJobSnapshotSchema.safeParse(dataNull).success).toBe(true);

    const dataUndefined = {
      job: {
        id: 'job-123',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        edition: 'free',
        status: IMPORT_JOB_STATUS.QUEUED,
        error: null,
        finishedAt: null,
        lastSeq: 0,
      },
      events: [],
    };
    expect(ImportJobSnapshotSchema.safeParse(dataUndefined).success).toBe(true);
  });
});

describe('readImportJobSnapshotInternal progressInfo integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyMock.mockResolvedValue([]);
    aggregateMock.mockResolvedValue({ _max: { seq: 0 } });
  });

  it('correctly reads options.progressInfo from database row and attaches to snapshot', async () => {
    const { readImportJobSnapshotInternal } = await import('@/lib/jobs/import-job-store');
    const now = new Date();
    findUniqueMock.mockResolvedValue({
      id: 'job-p1',
      userId: 'user-1',
      owner: 'acme',
      repo: 'widgets',
      branch: 'main',
      edition: '',
      status: IMPORT_JOB_STATUS.RUNNING,
      error: null,
      finishedAt: null,
      createdAt: now,
      options: {
        progressInfo: {
          step: '[4/5] 章节规划与认知投影构建...',
          progress: 75,
          updatedAt: '2026-09-21T08:00:00Z',
        },
      },
    });

    const snapshot = await readImportJobSnapshotInternal('job-p1');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.job.progressInfo).toEqual({
      step: '[4/5] 章节规划与认知投影构建...',
      progress: 75,
      updatedAt: '2026-09-21T08:00:00Z',
    });
  });

  it('safely handles null options or non-object progressInfo', async () => {
    const { readImportJobSnapshotInternal } = await import('@/lib/jobs/import-job-store');
    const now = new Date();

    // Case 1: options is null
    findUniqueMock.mockResolvedValueOnce({
      id: 'job-null-opt',
      userId: 'user-1',
      owner: 'acme',
      repo: 'widgets',
      branch: 'main',
      edition: '',
      status: IMPORT_JOB_STATUS.QUEUED,
      error: null,
      finishedAt: null,
      createdAt: now,
      options: null,
    });
    const snap1 = await readImportJobSnapshotInternal('job-null-opt');
    expect(snap1?.job.progressInfo).toBeNull();

    // Case 2: progressInfo is a corrupted string instead of object
    findUniqueMock.mockResolvedValueOnce({
      id: 'job-corrupt-opt',
      userId: 'user-1',
      owner: 'acme',
      repo: 'widgets',
      branch: 'main',
      edition: '',
      status: IMPORT_JOB_STATUS.RUNNING,
      error: null,
      finishedAt: null,
      createdAt: now,
      options: { progressInfo: 'corrupted-scalar' },
    });
    const snap2 = await readImportJobSnapshotInternal('job-corrupt-opt');
    expect(snap2?.job.progressInfo).toBeNull();
  });
});
