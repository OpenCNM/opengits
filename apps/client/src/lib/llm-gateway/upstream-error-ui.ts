import * as m from '@/paraglide/messages';
import {
  decodeStructuredDbError,
  parseClientStreamError,
  type UpstreamErrorMeta,
} from './upstream-error';

export type UpstreamErrorPrimaryAction = 'config_key' | 'switch_model' | 'retry';

export type UpstreamErrorMetadata = UpstreamErrorMeta;

export interface UpstreamErrorPresentation {
  code?: string;
  title: string;
  description: string;
  upstreamMessage?: string;
  provider?: string;
  model?: string;
  upstreamStatus?: number;
  upstreamCode?: string;
  primaryAction: UpstreamErrorPrimaryAction;
  showModelSwitcher: boolean;
  showConfigKey: boolean;
}

const KNOWN_GATEWAY_PREFIX_RE =
  /llm-gateway (KEY_DECRYPT_FAILED|MISSING_API_KEY|BUDGET_EXCEEDED|UPSTREAM_AUTH_ERROR|UPSTREAM_QUOTA_EXCEEDED|UPSTREAM_MODEL_NOT_FOUND|UPSTREAM_BAD_REQUEST|UPSTREAM_SERVER_ERROR|UPSTREAM_NETWORK_ERROR|RATE_LIMITED):/;

export function resolveUpstreamErrorPresentation(
  rawError: unknown,
  options?: {
    offline?: boolean;
    fallbackTitle?: string;
    fallbackDesc?: string;
  }
): UpstreamErrorPresentation {
  if (options?.offline) {
    return {
      code: 'OFFLINE',
      title: m.import_outline_network_offline(),
      description: m.import_outline_network_offline_desc(),
      primaryAction: 'retry',
      showModelSwitcher: false,
      showConfigKey: false,
    };
  }

  const errObj = (rawError && typeof rawError === 'object' ? rawError : null) as Record<string, unknown> | null;
  const metaObj =
    errObj?.meta && typeof errObj.meta === 'object' && !Array.isArray(errObj.meta)
      ? (errObj.meta as UpstreamErrorMeta)
      : null;
  const rawMessage = typeof rawError === 'string' ? rawError : String(errObj?.message ?? '');
  const streamParsed = parseClientStreamError(rawMessage);
  const dbParsed =
    decodeStructuredDbError(rawMessage) ??
    (typeof errObj?.detail === 'string' ? decodeStructuredDbError(errObj.detail) : null);

  let code =
    (typeof metaObj?.code === 'string' && metaObj.code) ||
    (typeof errObj?.code === 'string' && errObj.code) ||
    streamParsed.code ||
    dbParsed?.code ||
    KNOWN_GATEWAY_PREFIX_RE.exec(rawMessage)?.[1];

  const provider =
    (typeof errObj?.provider === 'string' && errObj.provider) ||
    metaObj?.provider ||
    streamParsed.provider ||
    dbParsed?.provider ||
    undefined;
  const model =
    (typeof errObj?.model === 'string' && errObj.model) ||
    metaObj?.model ||
    streamParsed.model ||
    dbParsed?.model ||
    undefined;
  const upstreamStatus =
    typeof errObj?.upstreamStatus === 'number'
      ? errObj.upstreamStatus
      : typeof metaObj?.upstreamStatus === 'number'
        ? metaObj.upstreamStatus
        : streamParsed.upstreamStatus ??
          dbParsed?.upstreamStatus ??
          (typeof errObj?.status === 'number' && errObj.status >= 400 ? errObj.status : undefined);
  const upstreamCode =
    (typeof errObj?.upstreamCode === 'string' && errObj.upstreamCode) ||
    metaObj?.upstreamCode ||
    streamParsed.upstreamCode ||
    dbParsed?.upstreamCode ||
    undefined;

  const strippedRawMessage = rawMessage
    .replace(/^(?:tree outline failed:\s*|outline failed:\s*|gateway [^:]+:\s*|llm-gateway [A-Z_]+:\s*)+/i, '')
    .trim();
  const upstreamMessage =
    (typeof errObj?.upstreamMessage === 'string' && errObj.upstreamMessage.trim()) ||
    (typeof metaObj?.upstreamMessage === 'string' && metaObj.upstreamMessage.trim()) ||
    (streamParsed.code ? streamParsed.message : '') ||
    dbParsed?.upstreamMessage ||
    (dbParsed ? '' : strippedRawMessage);

  const signalText = dbParsed?.upstreamMessage || metaObj?.upstreamMessage || rawMessage;

  if (!code && /Failed to fetch|NetworkError|net::ERR_|ENOTFOUND|ECONNREFUSED|aborted/i.test(signalText)) {
    code = 'UPSTREAM_NETWORK_ERROR';
  }
  if (!code && (upstreamStatus === 429 || /rate limit|ratelimit|throttling|toomanyrequests|速率限制|请求频率|并发超限/i.test(signalText))) {
    code = 'RATE_LIMITED';
  }
  if (!code && (upstreamStatus === 502 || upstreamStatus === 503 || upstreamStatus === 504)) {
    code = 'UPSTREAM_SERVER_ERROR';
  }

  switch (code) {
    case 'KEY_DECRYPT_FAILED':
      return {
        code,
        title: m.toast_key_decrypt_failed(),
        description: m.toast_key_decrypt_failed_desc(),
        provider,
        model,
        primaryAction: 'config_key',
        showModelSwitcher: false,
        showConfigKey: true,
      };
    case 'MISSING_API_KEY':
      return {
        code,
        title: m.toast_missing_api_key(),
        description: m.toast_missing_api_key(),
        provider,
        model,
        primaryAction: 'config_key',
        showModelSwitcher: false,
        showConfigKey: true,
      };
    case 'UPSTREAM_AUTH_ERROR':
      return {
        code,
        title: m.upstream_err_auth_title(),
        description: m.upstream_err_auth_desc(),
        upstreamMessage: upstreamMessage || undefined,
        provider,
        model,
        upstreamStatus,
        upstreamCode,
        primaryAction: 'config_key',
        showModelSwitcher: true,
        showConfigKey: true,
      };
    case 'UPSTREAM_QUOTA_EXCEEDED':
      return {
        code,
        title: m.upstream_err_quota_title(),
        description: m.upstream_err_quota_desc(),
        upstreamMessage: upstreamMessage || undefined,
        provider,
        model,
        upstreamStatus,
        upstreamCode,
        primaryAction: 'switch_model',
        showModelSwitcher: true,
        showConfigKey: true,
      };
    case 'UPSTREAM_MODEL_NOT_FOUND':
      return {
        code,
        title: m.upstream_err_model_not_found_title(),
        description: m.upstream_err_model_not_found_desc(),
        upstreamMessage: upstreamMessage || undefined,
        provider,
        model,
        upstreamStatus,
        upstreamCode,
        primaryAction: 'switch_model',
        showModelSwitcher: true,
        showConfigKey: true,
      };
    case 'UPSTREAM_BAD_REQUEST':
      return {
        code,
        title: m.upstream_err_bad_request_title(),
        description: m.upstream_err_bad_request_desc(),
        upstreamMessage: upstreamMessage || undefined,
        provider,
        model,
        upstreamStatus,
        upstreamCode,
        primaryAction: 'switch_model',
        showModelSwitcher: true,
        showConfigKey: false,
      };
    case 'RATE_LIMITED':
    case 'BUDGET_EXCEEDED':
      return {
        code,
        title: m.upstream_err_rate_limit_title(),
        description: m.upstream_err_rate_limit_desc(),
        upstreamMessage: upstreamMessage || undefined,
        provider,
        model,
        upstreamStatus,
        upstreamCode,
        primaryAction: 'retry',
        showModelSwitcher: true,
        showConfigKey: false,
      };
    case 'UPSTREAM_SERVER_ERROR':
      return {
        code,
        title: m.upstream_err_server_title(),
        description: m.upstream_err_server_desc(),
        upstreamMessage: upstreamMessage || undefined,
        provider,
        model,
        upstreamStatus,
        upstreamCode,
        primaryAction: 'retry',
        showModelSwitcher: true,
        showConfigKey: false,
      };
    case 'UPSTREAM_NETWORK_ERROR':
      return {
        code,
        title: m.upstream_err_network_title(),
        description: m.upstream_err_network_desc(),
        upstreamMessage: upstreamMessage || undefined,
        provider,
        model,
        upstreamStatus,
        upstreamCode,
        primaryAction: 'retry',
        showModelSwitcher: true,
        showConfigKey: true,
      };
    default: {
      const genericFallback = options?.fallbackDesc ?? m.import_outline_error_desc();
      const hasUsefulMsg =
        Boolean(upstreamMessage) &&
        !/^HTTP \d{3}:?/.test(upstreamMessage) &&
        upstreamMessage !== 'Stream error';
      return {
        code,
        title: options?.fallbackTitle ?? m.import_outline_error_title(),
        description: hasUsefulMsg ? genericFallback : genericFallback,
        upstreamMessage: hasUsefulMsg ? upstreamMessage : undefined,
        provider,
        model,
        upstreamStatus,
        upstreamCode,
        primaryAction: 'retry',
        showModelSwitcher: Boolean(provider || model || hasUsefulMsg),
        showConfigKey: false,
      };
    }
  }
}
