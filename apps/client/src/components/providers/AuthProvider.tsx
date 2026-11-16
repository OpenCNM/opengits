'use client';

import { SessionProvider } from "next-auth/react";
import { useSafeSession } from "@/lib/useSafeSession";
import { useEffect } from "react";
import { setTelemetryAuthenticated } from "@/lib/telemetry/beacon";

function AuthStateSync() {
  const { status } = useSafeSession();
  useEffect(() => {
    setTelemetryAuthenticated(status === 'authenticated');
  }, [status]);
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
