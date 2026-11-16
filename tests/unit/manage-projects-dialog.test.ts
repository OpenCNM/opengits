import { describe, expect, it, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ManageProjectsDialog } from '@/components/home/components/dashboard/ManageProjectsDialog';
import { DisplayRepo } from '@/lib/home-data';
import { setLocale } from '@/paraglide/runtime.js';

// Mock dialog primitives for server-side testing
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => (open ? React.createElement('div', { 'data-testid': 'dialog-root' }, children) : null),
  DialogPopup: ({ children, className }: any) => React.createElement('div', { 'data-testid': 'dialog-popup', className }, children),
  DialogHeader: ({ children }: any) => React.createElement('div', { 'data-testid': 'dialog-header' }, children),
  DialogTitle: ({ children }: any) => React.createElement('div', { 'data-testid': 'dialog-title' }, children),
  DialogDescription: ({ children }: any) => React.createElement('div', { 'data-testid': 'dialog-description' }, children),
  DialogFooter: ({ children, className }: any) => React.createElement('div', { 'data-testid': 'dialog-footer', className }, children),
}));

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({ open, title, description }: any) =>
    open ? React.createElement('div', { 'data-testid': 'confirm-dialog', 'data-title': title, 'data-description': description }) : null,
}));

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: any) => React.createElement('div', { 'data-testid': 'scroll-area' }, children),
}));

vi.mock('@/components/repo/RepoGithubOriginPopover', () => ({
  GithubIcon: () => React.createElement('span', { 'data-testid': 'github-icon' }, 'gh'),
}));

function createMockRepo(partial: Partial<DisplayRepo> & { id: string; owner: string; repo: string }): DisplayRepo {
  return {
    chapterCount: 10,
    processedDocsCount: 10,
    isFullyTranscribed: true,
    isSaved: true,
    savedCount: 1,
    progress: 20,
    viewedCount: 10,
    hasUpdate: false,
    importedSha: 'abc',
    isPinned: false,
    isMcpDisabled: false,
    lastReadPath: null,
    lastReadAt: null,
    ...partial,
  };
}

describe('ManageProjectsDialog (项目管理弹窗)', () => {
  beforeEach(() => {
    setLocale('zh-CN');
  });

  const mockRepos: DisplayRepo[] = [
    createMockRepo({
      id: 'repo-1',
      owner: 'lucide-icons',
      repo: 'lucide',
      isPinned: true,
      isPublic: true,
    }),
    createMockRepo({
      id: 'repo-2',
      owner: 'web-doc',
      repo: 'official-react-doc',
      title: 'React 官方正典',
      isPinned: false,
      isPublic: false,
    }),
  ];

  it('弹窗打开时正常渲染项目列表及标题', () => {
    const html = renderToString(
      React.createElement(ManageProjectsDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repos: mockRepos,
        onTogglePin: vi.fn(),
        onRemoveRepo: vi.fn(),
      })
    );

    // 验证弹窗基础结构存在
    expect(html).toContain('data-testid="dialog-popup"');
    expect(html).toContain('项目管理');

    // 验证项目名称完整可见（非截断为几个字母）
    expect(html).toContain('lucide-icons/');
    expect(html).toContain('lucide');
    expect(html).toContain('React 官方正典');

    // 验证已置顶标签
    expect(html).toContain('已置顶');

    // 验证精炼的副标题（去冗余、通俗直白）
    expect(html).toContain('支持置顶与移出');

    // 验证滚动容器与高度约束
    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('max-h-[75vh]');
  });

  it('当 open 为 false 时不渲染弹窗内容', () => {
    const html = renderToString(
      React.createElement(ManageProjectsDialog, {
        open: false,
        onOpenChange: vi.fn(),
        repos: mockRepos,
      })
    );

    expect(html).toBe('');
  });

  it('空书架时渲染空状态提示', () => {
    const html = renderToString(
      React.createElement(ManageProjectsDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repos: [],
      })
    );

    expect(html).toContain('data-testid="dialog-popup"');
    expect(html).toContain('书架暂空，前往广场挑选');
  });

  it('展示置顶与总数统计信息及操作按钮', () => {
    const html = renderToString(
      React.createElement(ManageProjectsDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repos: mockRepos,
        onTogglePin: vi.fn(),
        onRemoveRepo: vi.fn(),
      })
    );

    // 2 个项目，1 个已置顶
    expect(html).toContain('共 2 个项目 · 已置顶 1 个');
    expect(html).toContain('取消置顶');
    expect(html).toContain('置顶');
    expect(html).toContain('移出');
    expect(html).toContain('删除');
    expect(html).toContain('完成');
  });
});
