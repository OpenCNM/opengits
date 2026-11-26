import { Prisma, PrismaClient } from '@prisma/client';
import { resolveRuntimePrisma } from './runtime-endpoints';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const prismaClientOptions: Prisma.PrismaClientOptions = {
  log:
    process.env.NODE_ENV !== 'production' && process.env.PRISMA_QUERY_LOG !== 'false'
      ? ['query']
      : [],
};

function getDefaultPrismaClient(): PrismaClient {
  if (globalForPrisma.prisma) {
    if (process.env.NODE_ENV !== 'production' && !('userReadingProgress' in globalForPrisma.prisma)) {
      globalForPrisma.prisma = new PrismaClient(prismaClientOptions);
    }
    return globalForPrisma.prisma;
  }
  const client = new PrismaClient(prismaClientOptions);
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client;
  }
  return client;
}

function getActivePrismaClient(): PrismaClient {
  return resolveRuntimePrisma() ?? getDefaultPrismaClient();
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getActivePrismaClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
  has(_target, prop) {
    return prop in getActivePrismaClient();
  },
  ownKeys() {
    return Reflect.ownKeys(getActivePrismaClient());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const desc = Reflect.getOwnPropertyDescriptor(getActivePrismaClient(), prop);
    if (!desc) return undefined;
    return { ...desc, configurable: true };
  },
  getPrototypeOf() {
    return Object.getPrototypeOf(getActivePrismaClient());
  },
});
