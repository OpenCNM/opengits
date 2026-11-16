import { z } from 'zod';

/**
 * ─────────────────────────────────────────────────────────────
 * OAuth 2.1 协议层：Zod 模式校验与类型定义（Schema Triad）
 * 遵循 RFC 7591 (DCR), RFC 6749, RFC 7636 (PKCE), RFC 8252 (Native Apps)
 * ─────────────────────────────────────────────────────────────
 */

export function isValidRedirectUri(uri: string): boolean {
  if (!uri || typeof uri !== 'string') return false;
  // RFC 6749 §3.1.2: The redirection endpoint URI MUST NOT include a fragment component.
  if (uri.includes('#')) return false;
  try {
    const parsed = new URL(uri);
    // RFC 8252 §7.3: MUST NOT allow credentials in redirection URI
    if (parsed.username || parsed.password) {
      return false;
    }
    if (parsed.protocol === 'https:') {
      return true;
    }
    if (parsed.protocol === 'http:') {
      const host = parsed.hostname;
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'; // lint-ignore: IP-001 - loopback address validation for OAuth RFC 8252
    }
    return false;
  } catch {
    return false;
  }
}

export const oauthClientRegisterSchema = z.object({
  client_name: z.string().trim().min(1).max(100).default('mcp-client'),
  redirect_uris: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .refine(isValidRedirectUri, {
          message: 'redirect_uri must start with https:// or be a valid loopback http URI (localhost / 127.0.0.1 / [::1]) without fragment or credentials',
        })
    )
    .min(1, 'At least one redirect_uri is required')
    .max(20),
});

export type OAuthClientRegisterInput = z.infer<typeof oauthClientRegisterSchema>;

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: Date;
}

export interface OAuthAuthCode {
  code: string;
  clientId: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * 校验请求的 redirect_uri 是否在客户端预注册白名单中。
 * 遵循 RFC 8252 §7.3：对于本地 loopback 地址（localhost / 127.0.0.1 / [::1]），
 * 允许原生客户端在授权时使用动态随机分配的端口，但 host 与 pathname 必须与注册项一致。
 */
export function isRedirectUriAllowed(requestedUri: string, registeredUris: string[]): boolean {
  if (!requestedUri || !Array.isArray(registeredUris) || registeredUris.length === 0) {
    return false;
  }

  // RFC 6749 §3.1.2: 禁止携带 fragment
  if (requestedUri.includes('#')) {
    return false;
  }

  try {
    const reqUrl = new URL(requestedUri);
    // RFC 8252 §7.3: 禁止携带 userinfo
    if (reqUrl.username || reqUrl.password) {
      return false;
    }

    // 1. 完全精确匹配（针对非 loopback 或同端口）
    if (registeredUris.includes(requestedUri)) {
      return true;
    }

    const isLoopback =
      reqUrl.hostname === 'localhost' ||
      reqUrl.hostname === '127.0.0.1' || // lint-ignore: IP-001
      reqUrl.hostname === '[::1]';

    if (!isLoopback) {
      return false;
    }

    // 2. Loopback 动态端口放行：协议、hostname 与 pathname 均需匹配
    return registeredUris.some((registered) => {
      try {
        const regUrl = new URL(registered);
        if (regUrl.username || regUrl.password) return false;

        const regIsLoopback =
          regUrl.hostname === 'localhost' ||
          regUrl.hostname === '127.0.0.1' || // lint-ignore: IP-001
          regUrl.hostname === '[::1]';

        if (!regIsLoopback) return false;
        if (regUrl.protocol !== reqUrl.protocol) return false;
        if (regUrl.pathname !== reqUrl.pathname) return false;
        if (regUrl.search !== reqUrl.search) return false;
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}