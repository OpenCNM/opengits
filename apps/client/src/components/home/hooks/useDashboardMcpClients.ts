'use client';

import { useState, useEffect } from 'react';
import type { ActiveClientItem } from '../components/dashboard/DashboardMcpClientsPanel';

export function useDashboardMcpClients() {
  const [activeClients, setActiveClients] = useState<ActiveClientItem[]>([]);
  const [isLoadingClients, setIsLoadingClients] = useState(true);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let isMounted = true;

    const fallbackFetch = async () => {
      try {
        const res = await fetch('/api/mcp/active-clients');
        if (res.ok && isMounted) {
          const data = await res.json();
          const list = Array.isArray(data.data?.clients)
            ? data.data.clients
            : Array.isArray(data.clients)
            ? data.clients
            : [];
          setActiveClients(list);
        }
      } catch (err) {
        console.warn('[UserDashboardView] Fallback active clients fetch warning:', err);
      } finally {
        if (isMounted) setIsLoadingClients(false);
      }
    };

    try {
      eventSource = new EventSource('/api/mcp/active-clients/stream');

      eventSource.onmessage = (event) => {
        if (!isMounted) return;
        try {
          const data = JSON.parse(event.data);
          if (Array.isArray(data.clients)) {
            setActiveClients(data.clients);
          }
        } catch (err) {
          console.error('[EventSource] Failed to parse client data:', err);
        } finally {
          setIsLoadingClients(false);
        }
      };

      eventSource.onerror = () => {
        if (!isMounted) return;
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        // Fallback to standard HTTP GET if SSE stream errors or is 404
        fallbackFetch();
      };
    } catch {
      fallbackFetch();
    }

    return () => {
      isMounted = false;
      if (eventSource) {
        eventSource.close();
      }
    };
  }, []);

  return {
    activeClients,
    isLoadingClients,
  };
}
