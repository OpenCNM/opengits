'use client';

import { SessionProvider } from "next-auth/react";
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

    // 零残留清退：检测到真实 GitHub 会话建立，瞬时清空游客本地标记
    if (isAuth) {
      useGuestStore.getState().clearGuestMode();
    }
  }, [status, session?.user?.id]);

  return null;
}

export default function AuthProvider({
  children,
  basePath,
}: {
  children: React.ReactNode;
  basePath?: string;
}) {
  return (
    <SessionProvider basePath={basePath}>
      <AuthStateSync />
      {children}
    </SessionProvider>
  );
}
