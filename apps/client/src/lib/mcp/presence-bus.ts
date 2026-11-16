import { EventEmitter } from 'node:events';

/**
 * MCP 客户端在线状态事件总线（单进程事实源）。
 *
 * 物理事实只有两个：心跳到达（presence）与工具调用完成（call）。
 * 仪表盘 SSE 流订阅本总线实现事件驱动推送，取代时间采样轮询。
 * 多副本部署时只需替换传输层（Redis pub/sub），接口不变。
 */
export type PresenceEvent =
  | {
      type: 'presence';
      userId: string;
      clientName: string;
      clientVer?: string;
      at: number;
    }
  | {
      type: 'call';
      userId: string;
      clientName: string;
      status: string;
      hit: boolean;
      at: number;
    };

const PRESENCE_CHANNEL = 'mcp-presence';

const bus = new EventEmitter();
bus.setMaxListeners(0); // 每个 SSE 连接一个订阅者，不设上限

/** 发布事件（fire-and-forget，调用方不 await） */
export function publishPresence(event: PresenceEvent): void {
  bus.emit(PRESENCE_CHANNEL, event);
}

/**
 * 订阅某用户的事件；返回取消订阅函数。
 * 事件按 userId 过滤——无 userId 的事件不得推送给任何订阅者（跨用户隔离向量）。
 */
export function subscribePresence(
  userId: string,
  listener: (event: PresenceEvent) => void,
): () => void {
  const filtered = (event: PresenceEvent) => {
    if (event.userId === userId) listener(event);
  };
  bus.on(PRESENCE_CHANNEL, filtered);
  return () => {
    bus.off(PRESENCE_CHANNEL, filtered);
  };
}
