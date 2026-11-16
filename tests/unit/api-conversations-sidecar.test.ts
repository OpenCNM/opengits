import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

const getSessionHelperMock = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: (...args: unknown[]) => getSessionHelperMock(...args),
  getAdminUserHelper: (...args: unknown[]) => getSessionHelperMock(...args),
}));

describe('Conversations API (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/conversations', () => {
    async function callList(url: string) {
      const { GET } = await import('@/app/api/conversations/route');
      const req = new NextRequest(url, { method: 'GET' });
      return GET(req);
    }

    it('未登录时返回 401', async () => {
      getSessionHelperMock.mockResolvedValue(null);
      const res = await callList('http://localhost/api/conversations?owner=fb&repo=react');
      expect(res.status).toBe(401);
    });

    it('缺少 owner 或 repo 时返回 400', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      const res = await callList('http://localhost/api/conversations?owner=fb');
      expect(res.status).toBe(400);
    });

    it('仓库不存在时返回 404', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      callSidecarMock.mockResolvedValueOnce({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Repository not found',
      });
      const res = await callList('http://localhost/api/conversations?owner=fb&repo=nonexistent');
      expect(res.status).toBe(404);
    });

    it('无权访问私有仓时返回 403', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      callSidecarMock.mockResolvedValueOnce({
        ok: false,
        code: 'FORBIDDEN',
        error: 'Forbidden: You do not have access to this repository',
      });
      const res = await callList('http://localhost/api/conversations?owner=fb&repo=private-repo');
      expect(res.status).toBe(403);
    });

    it('正常拉取会话列表', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      const mockConvs = [
        {
          id: 'conv-1',
          title: 'Chat 1',
          createdAt: '2026-09-21T00:00:00Z',
          updatedAt: '2026-09-21T01:00:00Z',
        },
      ];
      callSidecarMock.mockResolvedValueOnce({
        ok: true,
        conversations: mockConvs,
      });

      const res = await callList('http://localhost/api/conversations?owner=fb&repo=react');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        data: mockConvs,
      });

      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/conversations/list',
        { owner: 'fb', repo: 'react', userId: 'usr-123' },
        expect.objectContaining({ label: 'conversations /v1/conversations/list' })
      );
    });
  });

  describe('GET /api/conversations/[id]', () => {
    async function callGetMessages(id: string) {
      const { GET } = await import('@/app/api/conversations/[id]/route');
      const req = new NextRequest(`http://localhost/api/conversations/${id}`, { method: 'GET' });
      return GET(req, { params: Promise.resolve({ id }) });
    }

    it('未登录时返回 401', async () => {
      getSessionHelperMock.mockResolvedValue(null);
      const res = await callGetMessages('conv-1');
      expect(res.status).toBe(401);
    });

    it('会话不存在时返回 404', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      callSidecarMock.mockResolvedValueOnce({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Conversation not found',
      });
      const res = await callGetMessages('conv-missing');
      expect(res.status).toBe(404);
    });

    it('正常获取消息列表', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      const mockMessages = [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hello AI',
          createdAt: '2026-09-21T00:00:00Z',
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Hello human',
          createdAt: '2026-09-21T00:01:00Z',
        },
      ];
      callSidecarMock.mockResolvedValueOnce({
        ok: true,
        messages: mockMessages,
      });

      const res = await callGetMessages('conv-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        data: mockMessages,
      });

      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/conversations/messages',
        { conversationId: 'conv-1', userId: 'usr-123' },
        expect.objectContaining({ label: 'conversations /v1/conversations/messages' })
      );
    });
  });

  describe('POST /api/conversations', () => {
    async function callCreate(body: unknown) {
      const { POST } = await import('@/app/api/conversations/route');
      const req = new NextRequest('http://localhost/api/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return POST(req);
    }

    it('未登录时返回 401', async () => {
      getSessionHelperMock.mockResolvedValue(null);
      const res = await callCreate({ owner: 'fb', repo: 'react', title: 'New Chat' });
      expect(res.status).toBe(401);
    });

    it('缺少 owner 或 repo 时返回 400', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      const res = await callCreate({ owner: 'fb' });
      expect(res.status).toBe(400);
    });

    it('仓库不存在时返回 404', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      callSidecarMock.mockResolvedValueOnce({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Repository not found',
      });
      const res = await callCreate({ owner: 'fb', repo: 'nonexistent' });
      expect(res.status).toBe(404);
    });

    it('无权访问私有仓时返回 403', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      callSidecarMock.mockResolvedValueOnce({
        ok: false,
        code: 'FORBIDDEN',
        error: 'Forbidden: You do not have access to this repository',
      });
      const res = await callCreate({ owner: 'fb', repo: 'private-repo' });
      expect(res.status).toBe(403);
    });

    it('正常创建会话', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      const mockConv = {
        id: 'conv-new-1',
        userId: 'usr-123',
        repositoryId: 'repo-1',
        title: 'My Topic',
        createdAt: '2026-09-22T00:00:00Z',
        updatedAt: '2026-09-22T00:00:00Z',
      };
      callSidecarMock.mockResolvedValueOnce({
        ok: true,
        conversation: mockConv,
      });

      const res = await callCreate({ owner: 'fb', repo: 'react', title: 'My Topic' });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        success: true,
        data: mockConv,
      });

      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/conversations/create',
        { owner: 'fb', repo: 'react', userId: 'usr-123', title: 'My Topic' },
        expect.objectContaining({ label: 'conversations /v1/conversations/create' })
      );
    });
  });

  describe('PUT /api/conversations/[id]', () => {
    async function callUpdate(id: string, body: unknown) {
      const { PUT } = await import('@/app/api/conversations/[id]/route');
      const req = new NextRequest(`http://localhost/api/conversations/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return PUT(req, { params: Promise.resolve({ id }) });
    }

    it('未登录时返回 401', async () => {
      getSessionHelperMock.mockResolvedValue(null);
      const res = await callUpdate('conv-1', { title: 'Renamed' });
      expect(res.status).toBe(401);
    });

    it('title 为空时返回 400', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      const res = await callUpdate('conv-1', { title: '   ' });
      expect(res.status).toBe(400);
    });

    it('会话不存在时返回 404', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      callSidecarMock.mockResolvedValueOnce({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Conversation not found',
      });
      const res = await callUpdate('conv-missing', { title: 'Renamed' });
      expect(res.status).toBe(404);
    });

    it('正常更新会话标题', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      const mockUpdated = {
        id: 'conv-1',
        userId: 'usr-123',
        repositoryId: 'repo-1',
        title: 'Renamed Chat',
        createdAt: '2026-09-22T00:00:00Z',
        updatedAt: '2026-09-22T01:00:00Z',
      };
      callSidecarMock.mockResolvedValueOnce({
        ok: true,
        conversation: mockUpdated,
      });

      const res = await callUpdate('conv-1', { title: 'Renamed Chat' });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        success: true,
        data: mockUpdated,
      });

      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/conversations/update',
        { id: 'conv-1', userId: 'usr-123', title: 'Renamed Chat' },
        expect.objectContaining({ label: 'conversations /v1/conversations/update' })
      );
    });
  });

  describe('DELETE /api/conversations/[id]', () => {
    async function callDelete(id: string) {
      const { DELETE } = await import('@/app/api/conversations/[id]/route');
      const req = new NextRequest(`http://localhost/api/conversations/${id}`, {
        method: 'DELETE',
      });
      return DELETE(req, { params: Promise.resolve({ id }) });
    }

    it('未登录时返回 401', async () => {
      getSessionHelperMock.mockResolvedValue(null);
      const res = await callDelete('conv-1');
      expect(res.status).toBe(401);
    });

    it('会话不存在时返回 404', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      callSidecarMock.mockResolvedValueOnce({
        ok: false,
        code: 'NOT_FOUND',
        error: 'Conversation not found',
      });
      const res = await callDelete('conv-missing');
      expect(res.status).toBe(404);
    });

    it('正常删除会话', async () => {
      getSessionHelperMock.mockResolvedValue({
        user: { id: 'usr-123' },
        expires: '2099-01-01',
      });
      callSidecarMock.mockResolvedValueOnce({
        ok: true,
        message: 'Conversation deleted',
      });

      const res = await callDelete('conv-1');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        success: true,
        data: { message: 'Conversation deleted' },
      });

      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/conversations/delete',
        { id: 'conv-1', userId: 'usr-123' },
        expect.objectContaining({ label: 'conversations /v1/conversations/delete' })
      );
    });
  });
});
