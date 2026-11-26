import { z } from 'zod';

export function isValidRedirectUri(uri: string): boolean {
  if (!uri || typeof uri !== 'string') return false;
  if (uri.includes('#')) return false;
  try {
    const parsed = new URL(uri);
    if (parsed.username || parsed.password) {
      return false;
    }
    if (parsed.protocol === 'https:') {
      return true;
    }
    if (parsed.protocol === 'http:') {
      const host = parsed.hostname;
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'; // lint-ignore: IP-001
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

export function isRedirectUriAllowed(requestedUri: string, registeredUris: string[]): boolean {
  if (!requestedUri || !Array.isArray(registeredUris) || registeredUris.length === 0) {
    return false;
  }

  if (requestedUri.includes('#')) {
    return false;
  }

  try {
    const reqUrl = new URL(requestedUri);
    if (reqUrl.username || reqUrl.password) {
      return false;
    }

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