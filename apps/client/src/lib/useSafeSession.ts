'use client';

import { useSession } from 'next-auth/react';

/**
 * Safe wrapper around next-auth/react's useSession.
 * Prevents runtime errors like "[next-auth]: `useSession` must be wrapped in a <SessionProvider />"
 * when AuthProvider/SessionProvider is unmounted, bypassed in dev mode, or unavailable.
 */
export function useSafeSession() {
  try {
    return useSession();
  } catch {
    return {
      data: null,
      status: 'unauthenticated' as const,
      update: async () => null,
    };
  }
}
