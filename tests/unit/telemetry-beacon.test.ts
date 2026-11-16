import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { trackEvent, flushQueue, setTelemetryAuthenticated } from '@/lib/telemetry/beacon';

describe('telemetry/beacon（客户端事件流聚合与限流熔断）', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('window', {
      location: { pathname: '/docs/ch1' },
    });
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    setTelemetryAuthenticated(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('未登录时静默清空队列，避免触发 401 噪音', () => {
    setTelemetryAuthenticated(false);
    trackEvent({ eventType: 'PAGE_VIEW', targetId: '/docs/ch1', immediate: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SCROLL_PROGRESS 在队列中单调去重合并，防止同一章节高频滑动堆积多条事件', () => {
    // 第一次记录 30%
    trackEvent({
      eventType: 'SCROLL_PROGRESS',
      targetId: '/docs/ch1',
      duration: 1000,
      metadata: { scrollPercent: 30 },
    });

    // 第二次记录 80%
    trackEvent({
      eventType: 'SCROLL_PROGRESS',
      targetId: '/docs/ch1',
      duration: 5000,
      metadata: { scrollPercent: 80 },
    });

    // 触发上报
    flushQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // 队列中应仅聚合为 1 条事件，且包含最大滚动百分比 80%
    expect(body.events).toHaveLength(1);
    expect(body.events[0].metadata.scrollPercent).toBe(80);
    expect(body.events[0].duration).toBe(5000);
  });

  it('收到 429 限流时自动进入 60 秒冷却，后续上报静默挂起不冲击服务端', async () => {
    fetchMock.mockClear();
    // 模拟服务端返回 429
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });

    trackEvent({ eventType: 'PAGE_VIEW', targetId: '/docs/ch1', immediate: true });
    // 等待 microtask 处理完成 .then()
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 此时已经处于 429 冷却期，再次尝试 flushQueue 应直接返回，不再发起网络请求
    trackEvent({ eventType: 'PAGE_VIEW', targetId: '/docs/ch2', immediate: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 仍为 1 次，未发生二次冲击
  });
});
