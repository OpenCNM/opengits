'use client';

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { useSafeSession } from "@/lib/useSafeSession";
import { useEffect } from "react";
import { setTelemetryAuthenticated } from "@/lib/telemetry/beacon";
import { useGuestStore, initGuestCrossTabSync } from "@/lib/stores/guest-store";
import { usePermissionStore } from "@/lib/permissions/permission-store";

function AuthStateSync() {
  const { status, data: session } = useSafeSession();

  useEffect(() => {
    const cleanup = initGuestCrossTabSync();
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const isAuth = status === 'authenticated' && Boolean(session?.user?.id);
    setTelemetryAuthenticated(isAuth);
    usePermissionStore.getState().setAuthState(isAuth, session?.user?.id);

    if (isAuth) {
      useGuestStore.getState().clearGuestMode();
    }
  }, [status, session?.user?.id]);

  return null;
}

export default function AuthProvider({
  children,
  basePath,
  session,
}: {
  children: React.ReactNode;
  basePath?: string;
  session?: Session | null;
}) {
  return (
    <SessionProvider basePath={basePath} session={session}>
      <AuthStateSync />
      {children}
    </SessionProvider>
  );
}
