import type { PrismaClient } from '@prisma/client';

export interface RuntimeEndpointOverrides {
  workerSidecar?: string;
  webInternalUrl?: string;
  internalApiToken?: string;
}

type PrismaResolver = () => PrismaClient;
type EndpointResolver = () => RuntimeEndpointOverrides;

const globalForRuntime = globalThis as unknown as {
  __opengitsPrismaResolver?: PrismaResolver | null;
  __opengitsRuntimeEndpointsResolver?: EndpointResolver | null;
};

// Optional process-level resolver hook for opengits-admin local/prod DB switching; zero cost when unset.
export function registerRuntimePrismaResolver(resolver: PrismaResolver | null): void {
  globalForRuntime.__opengitsPrismaResolver = resolver;
}

export function resolveRuntimePrisma(): PrismaClient | null {
  const fn = globalForRuntime.__opengitsPrismaResolver;
  return typeof fn === 'function' ? fn() : null;
}

export function registerRuntimeEndpointsResolver(resolver: EndpointResolver | null): void {
  globalForRuntime.__opengitsRuntimeEndpointsResolver = resolver;
}

export function resolveRuntimeEndpoints(): RuntimeEndpointOverrides | null {
  const fn = globalForRuntime.__opengitsRuntimeEndpointsResolver;
  return typeof fn === 'function' ? fn() : null;
}
