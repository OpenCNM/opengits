import { getServerSession, NextAuthOptions, type Session } from "next-auth";
import { ignoreBestEffort } from "@/lib/best-effort";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";
import { callSidecar } from "@/lib/sidecar-client";
import { prisma } from "@/lib/db";
import GithubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import AzureADProvider from "next-auth/providers/azure-ad";
import { resolveSecret } from "@/lib/secrets";
import { cache } from "react";
import { cookies } from "next/headers";
import { createHash } from "crypto";
import type { AdminUser } from "@prisma/client";
import { TtlCache } from "@/lib/cache/ttl-cache";
import {
  SESSION_CACHE_TTL_MS,
  SESSION_CACHE_MAX_ENTRIES,
  ADMIN_CACHE_TTL_MS,
  ADMIN_CACHE_MAX_ENTRIES,
} from "@/lib/constants";

const isGoogleConfigured = Boolean(
  (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_ID) &&
  (process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_SECRET)
);

const isAzureADConfigured = Boolean(
  (process.env.AZURE_AD_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID) &&
  (process.env.AZURE_AD_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET)
);

function createCustomPrismaAdapter(): Adapter {
  const base = PrismaAdapter(prisma);
  return {
    ...base,
    createUser: async (data: Omit<AdapterUser, 'id'>) => {
      const resp = await callSidecar<{ ok: boolean; user: any }>(
        '/v1/user/auth-create',
        {
          name: data.name ?? null,
          email: data.email ?? null,
          image: data.image ?? null,
          grantGift: true,
        },
        { label: 'auth-create-user' }
      );
      if (!resp?.user) {
        throw new Error('Failed to create auth user via sidecar');
      }
      return resp.user;
    },
    updateUser: async (user: Partial<AdapterUser> & Pick<AdapterUser, 'id'>) => {
      const resp = await callSidecar<{ ok: boolean; user: any }>(
        '/v1/user/update',
        {
          id: user.id,
          name: user.name ?? undefined,
          email: user.email ?? undefined,
          image: user.image ?? undefined,
        },
        { label: 'auth-update-user' }
      );
      if (!resp?.user) {
        throw new Error('Failed to update auth user via sidecar');
      }
      return resp.user;
    },
    deleteUser: async (userId: string) => {
      await callSidecar(
        '/v1/user/delete',
        { id: userId },
        { label: 'auth-delete-user' }
      );
    },
    linkAccount: async (account: AdapterAccount) => {
      const {
        userId,
        type,
        provider,
        providerAccountId,
        refresh_token,
        access_token,
        expires_at,
        refresh_token_expires_in,
        token_type,
        scope,
        id_token,
        session_state
      } = account;

      return await prisma.account.create({
        data: {
          userId,
          type,
          provider,
          providerAccountId,
          refresh_token: refresh_token ?? null,
          access_token: access_token ?? null,
          expires_at: expires_at ? Number(expires_at) : null,
          refresh_token_expires_in: refresh_token_expires_in ? Number(refresh_token_expires_in) : null,
          token_type: token_type ?? null,
          scope: scope ?? null,
          id_token: id_token ?? null,
          session_state: session_state ?? null,
        }
      });
    }
  };
}

export const authOptions: NextAuthOptions = {
  adapter: createCustomPrismaAdapter(),
  session: {
    strategy: "jwt",
  },
  providers: [
    GithubProvider({
      clientId: (process.env.GITHUB_ID || "").trim(),
      clientSecret: (process.env.GITHUB_SECRET || "").trim(),
      // Block automatic email-based OAuth linking so unverified emails cannot hijack existing accounts.
      allowDangerousEmailAccountLinking: false,
    }),
    ...(isGoogleConfigured ? [
      GoogleProvider({
        clientId: (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_ID || "").trim(),
        clientSecret: (process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_SECRET || "").trim(),
      allowDangerousEmailAccountLinking: false,
      })
    ] : []),
    ...(isAzureADConfigured ? [
      AzureADProvider({
        clientId: (process.env.AZURE_AD_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID || "").trim(),
        clientSecret: (process.env.AZURE_AD_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET || "").trim(),
        tenantId: (process.env.AZURE_AD_TENANT_ID || "common").trim(),
      allowDangerousEmailAccountLinking: false,
      })
    ] : []),
  ],
  callbacks: {
    signIn: async () => {
      return true;
    },
    jwt: async ({ token, user, account }) => {
      if (user) {
        token.sub = user.id;
        token.email = user.email;
        token.name = user.name;
        token.picture = user.image;
      }
      if (account?.access_token) {
        token.accessToken = account.access_token;
        const targetUserId = (user?.id || token.sub) as string | undefined;
        if (targetUserId && account.provider) {
          try {
            await prisma.account.updateMany({
              where: {
                userId: targetUserId,
                provider: account.provider,
              },
              data: {
                access_token: account.access_token,
                expires_at: account.expires_at ? Number(account.expires_at) : null,
                refresh_token: account.refresh_token ?? undefined,
                token_type: account.token_type ?? undefined,
                scope: account.scope ?? undefined,
              },
            });
          } catch (e) {
            console.warn('[auth] Failed to sync account tokens:', e);
          }
        }
      }
      return token;
    },
    session: ({ session, token }) => {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
  pages: {
    signIn: '/auth/signin',
  },
  secret: resolveSecret('NEXTAUTH_SECRET', 'dev_only_insecure_nextauth_secret_DO_NOT_USE_IN_PRODUCTION'),
};

export const sessionJweCache = new TtlCache<Session | null>(
  SESSION_CACHE_TTL_MS,
  SESSION_CACHE_MAX_ENTRIES
);

export const adminCache = new TtlCache<AdminUser | null>(
  ADMIN_CACHE_TTL_MS,
  ADMIN_CACHE_MAX_ENTRIES
);

export function extractSessionCookieHash(
  cookiesList: Array<{ name: string; value: string }>
): string | null {
  const sessionTokens = cookiesList
    .filter((c) => c.name.includes('next-auth.session-token'))
    .map((c) => `${c.name}=${c.value}`)
    .sort()
    .join(';');

  if (!sessionTokens) {
    return null;
  }
  return createHash('sha256').update(sessionTokens).digest('hex');
}

async function getSessionHelperCore(): Promise<Session | null> {
  let cookieHash: string | null = null;
  try {
    const cookieStore = await cookies();
    cookieHash = extractSessionCookieHash(cookieStore.getAll());
    if (!cookieHash) {
      return null;
    }
  } catch {
    ignoreBestEffort();
    try {
      return await getServerSession(authOptions);
    } catch {
      ignoreBestEffort();
      return null;
    }
  }

  const cached = sessionJweCache.get(cookieHash);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const session = await getServerSession(authOptions);
    sessionJweCache.set(cookieHash, session);
    return session;
  } catch (err) {
    console.error('[auth-helper] getServerSession decrypt error:', err);
    sessionJweCache.set(cookieHash, null);
    return null;
  }
}

export const getSessionHelper = cache(getSessionHelperCore);

async function getAdminUserHelperCore(): Promise<AdminUser | null> {
  const session = await getSessionHelper();
  if (!session?.user?.email) return null;

  const email = session.user.email.toLowerCase();
  const cached = adminCache.get(email);
  if (cached !== undefined) {
    return cached;
  }

  let adminUser = await prisma.adminUser.findUnique({
    where: { email },
  });

  if (adminUser) {
    const result = adminUser.isActive ? adminUser : null;
    adminCache.set(email, result);
    return result;
  }

  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const isInAdminEmails = adminEmails.includes(email);

  let userRoleIsAdmin = false;
  if (!isInAdminEmails) {
    const dbUser = await prisma.user.findUnique({
      where: { email },
      select: { role: true },
    });
    if (dbUser && (dbUser.role === 'ADMIN' || dbUser.role === 'SUPER_ADMIN')) {
      userRoleIsAdmin = true;
    }
  }

  if (isInAdminEmails || userRoleIsAdmin) {
    try {
      adminUser = await prisma.adminUser.upsert({
        where: { email },
        update: { isActive: true },
        create: {
          email,
          name: session.user.name || email,
          role: 'SUPER_ADMIN',
          isActive: true,
        },
      });
      adminCache.set(email, adminUser);
      return adminUser;
    } catch (e) {
      console.error('[auth-helper] Failed to auto-provision admin user:', e);
    }
  }

  adminCache.set(email, null);
  return null;
}

export const getAdminUserHelper = cache(getAdminUserHelperCore);

