import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveWorkbenchDraft,
  loadWorkbenchDraft,
  clearWorkbenchDraft,
  formatDraftTimeAgo,
  canonicalizeOutline,
  WORKBENCH_DRAFT_MAX_AGE_MS,
  type WorkbenchDraftData,
} from '@/lib/import-wizard/draft-storage';
import { STORAGE_KEYS } from '@/lib/constants';

const storeMap = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => storeMap.get(k) ?? null,
  setItem: (k: string, v: string) => storeMap.set(k, String(v)),
  removeItem: (k: string) => storeMap.delete(k),
  clear: () => storeMap.clear(),
  length: 0,
  key: (i: number) => Array.from(storeMap.keys())[i] || null,
};

vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('window', {
  localStorage: localStorageMock,
});

describe('workbench-draft-storage', () => {
  const owner = 'test-owner';
  const repo = 'test-repo';
  const sampleOutline = [
    {
      name: '基础入门',
      files: [
        { path: 'src/index.ts', shortTitle: '入口模块' },
        { path: 'src/utils.ts', shortTitle: '工具集' },
      ],
    },
  ];

  beforeEach(() => {
    storeMap.clear();
    vi.restoreAllMocks();
  });

  describe('saveWorkbenchDraft & loadWorkbenchDraft', () => {
    it('should correctly persist and load draft', () => {
      const ok = saveWorkbenchDraft(owner, repo, {
        sha: 'abc1234',
        customOutline: sampleOutline,
        customPrompt: 'Focus on performance',
        transcriptionPreset: 'deep-dive',
        targetLanguage: 'zh-CN',
      });
      expect(ok).toBe(true);

      const loaded = loadWorkbenchDraft(owner, repo, 'abc1234');
      expect(loaded).not.toBeNull();
      expect(loaded?.owner).toBe(owner);
      expect(loaded?.repo).toBe(repo);
      expect(loaded?.sha).toBe('abc1234');
      expect(loaded?.customOutline).toEqual(sampleOutline);
      expect(loaded?.customPrompt).toBe('Focus on performance');
      expect(loaded?.transcriptionPreset).toBe('deep-dive');
      expect(loaded?.targetLanguage).toBe('zh-CN');
      expect(typeof loaded?.updatedAt).toBe('number');
    });

    it('should reject invalid arguments for save', () => {
      expect(saveWorkbenchDraft('', repo, { customOutline: sampleOutline })).toBe(false);
      expect(saveWorkbenchDraft(owner, '', { customOutline: sampleOutline })).toBe(false);
      expect(saveWorkbenchDraft(owner, repo, { customOutline: [] })).toBe(false);
    });

    it('should return null when loading non-existent draft', () => {
      expect(loadWorkbenchDraft('none', 'none')).toBeNull();
    });

    it('should auto-purge and return null for expired draft', () => {
      const expiredTime = Date.now() - (WORKBENCH_DRAFT_MAX_AGE_MS + 1000);
      const expiredDraft: WorkbenchDraftData = {
        owner,
        repo,
        updatedAt: expiredTime,
        customOutline: sampleOutline,
      };
      localStorageMock.setItem(STORAGE_KEYS.WORKBENCH_DRAFT(owner, repo), JSON.stringify(expiredDraft));

      const loaded = loadWorkbenchDraft(owner, repo);
      expect(loaded).toBeNull();
      expect(localStorageMock.getItem(STORAGE_KEYS.WORKBENCH_DRAFT(owner, repo))).toBeNull();
    });

    it('should auto-purge if owner or repo in payload mismatches key', () => {
      const mismatchedDraft: WorkbenchDraftData = {
        owner: 'other-owner',
        repo,
        updatedAt: Date.now(),
        customOutline: sampleOutline,
      };
      localStorageMock.setItem(STORAGE_KEYS.WORKBENCH_DRAFT(owner, repo), JSON.stringify(mismatchedDraft));

      const loaded = loadWorkbenchDraft(owner, repo);
      expect(loaded).toBeNull();
      expect(localStorageMock.getItem(STORAGE_KEYS.WORKBENCH_DRAFT(owner, repo))).toBeNull();
    });
  });

  describe('clearWorkbenchDraft', () => {
    it('should cleanly remove draft from localStorage', () => {
      saveWorkbenchDraft(owner, repo, { customOutline: sampleOutline });
      expect(loadWorkbenchDraft(owner, repo)).not.toBeNull();

      clearWorkbenchDraft(owner, repo);
      expect(loadWorkbenchDraft(owner, repo)).toBeNull();
    });
  });

  describe('formatDraftTimeAgo', () => {
    it('should format recently updated as 刚刚', () => {
      expect(formatDraftTimeAgo(Date.now() - 10000)).toBe('刚刚');
    });

    it('should format minutes ago', () => {
      expect(formatDraftTimeAgo(Date.now() - 5 * 60 * 1000)).toBe('5 分钟前');
    });

    it('should format hours ago', () => {
      expect(formatDraftTimeAgo(Date.now() - 3 * 3600 * 1000)).toBe('3 小时前');
    });

    it('should format days ago', () => {
      expect(formatDraftTimeAgo(Date.now() - 2 * 86400 * 1000)).toBe('2 天前');
    });
  });

  describe('canonicalizeOutline', () => {
    it('should trim names, deduplicate files, filter empty categories, and backfill shortTitle', () => {
      const rawOutline = [
        {
          name: '  核心引擎  ',
          files: [
            { path: '  src/engine/core.ts  ', shortTitle: '  核心逻辑  ' },
            { path: 'src/engine/core.ts', shortTitle: '重复路径会被去重' },
            { path: 'src/engine/config.json', shortTitle: '' }, // 空 shortTitle 应退火为 basename config
          ],
        },
        {
          name: '   ', // 空分类名称应退火
          files: [
            { path: 'README.md', shortTitle: undefined }, // 应退火为 README
          ],
        },
        {
          name: '空章节应被过滤',
          files: [],
        },
      ];

      const cleaned = canonicalizeOutline(rawOutline);

      expect(cleaned).toHaveLength(2);
      expect(cleaned[0].name).toBe('核心引擎');
      expect(cleaned[0].files).toHaveLength(2);
      expect(cleaned[0].files[0]).toEqual({
        path: 'src/engine/core.ts',
        shortTitle: '核心逻辑',
      });
      expect(cleaned[0].files[1]).toEqual({
        path: 'src/engine/config.json',
        shortTitle: 'config',
      });

      expect(cleaned[1].name).toBe('未命名章节');
      expect(cleaned[1].files).toHaveLength(1);
      expect(cleaned[1].files[0].shortTitle).toBe('README');
    });

    it('should fall back to cat.title when cat.name is missing and preserve partTitle', () => {
      const rawOutline = [
        {
          title: '第 1 章: 架构总览',
          partTitle: '模块 1: 架构全景与环境准备',
          files: [{ path: 'README.md' }],
        },
      ];
      const cleaned = canonicalizeOutline(rawOutline as any);
      expect(cleaned).toHaveLength(1);
      expect(cleaned[0].name).toBe('第 1 章: 架构总览');
      expect((cleaned[0] as any).partTitle).toBe('模块 1: 架构全景与环境准备');
    });

    it('should return empty array for non-array or empty inputs', () => {
      expect(canonicalizeOutline(null as any)).toEqual([]);
      expect(canonicalizeOutline([] as any)).toEqual([]);
    });
  });
});
