import { getServerSession, NextAuthOptions, type Session } from "next-auth";
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

// 辅助检测 Google Provider 是否已配置
const isGoogleConfigured = Boolean(
  (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_ID) &&
  (process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_SECRET)
);

// 辅助检测 AzureAD / Microsoft Provider 是否已配置
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
      // 关闭跨 Provider 邮箱自动链接：GitHub secondary email 可未验证，任一
      // IdP 存在未验证邮箱即可用同邮箱登入他人账号（NextAuth 官方安全告警）
      allowDangerousEmailAccountLinking: false,
    }),
    ...(isGoogleConfigured ? [
      GoogleProvider({
        clientId: (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_ID || "").trim(),
        clientSecret: (process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_SECRET || "").trim(),
        // 关闭跨 Provider 邮箱自动链接：GitHub secondary email 可未验证，任一
      // IdP 存在未验证邮箱即可用同邮箱登入他人账号（NextAuth 官方安全告警）
      allowDangerousEmailAccountLinking: false,
      })
    ] : []),
    ...(isAzureADConfigured ? [
      AzureADProvider({
        clientId: (process.env.AZURE_AD_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID || "").trim(),
        clientSecret: (process.env.AZURE_AD_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET || "").trim(),
        tenantId: (process.env.AZURE_AD_TENANT_ID || "common").trim(),
        // 关闭跨 Provider 邮箱自动链接：GitHub secondary email 可未验证，任一
      // IdP 存在未验证邮箱即可用同邮箱登入他人账号（NextAuth 官方安全告警）
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

// 进程内 Edge Auth Cache：NextAuth Session JWE 解密缓存与 Admin 角色查询缓存
export const sessionJweCache = new TtlCache<Session | null>(
  SESSION_CACHE_TTL_MS,
  SESSION_CACHE_MAX_ENTRIES
);

export const adminCache = new TtlCache<AdminUser | null>(
  ADMIN_CACHE_TTL_MS,
  ADMIN_CACHE_MAX_ENTRIES
);

/**
 * 提取 session cookie 并生成 sha256 摘要（支持 __Secure- 前缀与 .0, .1 分片，空返回 null）
 */
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
      // 若请求头无 session cookie，短路返回 null，切除 NextAuth 内部开销
      return null;
    }
  } catch {
    // 非请求上下文（如单测或独立脚本）回退原生 getServerSession
    try {
      return await getServerSession(authOptions);
    } catch {
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
    // 损坏/恶意 session cookie fail-soft 返回 null，防 500 崩溃与异常击穿
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

  // 1. Query existing AdminUser record
  let adminUser = await prisma.adminUser.findUnique({
    where: { email },
  });

  if (adminUser) {
    const result = adminUser.isActive ? adminUser : null;
    adminCache.set(email, result);
    return result;
  }

  // 2. Check auto-provisioning conditions:
  // - Email listed in ADMIN_EMAILS environment variable
  // - User in User table with role === 'ADMIN' or 'SUPER_ADMIN'
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


