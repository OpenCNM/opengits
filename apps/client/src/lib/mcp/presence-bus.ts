import { EventEmitter } from 'node:events';

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
bus.setMaxListeners(0); // One listener per active SSE stream.

export function publishPresence(event: PresenceEvent): void {
  bus.emit(PRESENCE_CHANNEL, event);
}

// Filter strictly by userId to enforce cross-tenant isolation.
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
