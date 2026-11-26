import * as m from '@/paraglide/messages';

export function resolveProviderTestErrorMessage(code?: string, rawFallback?: string): string {
  switch (code) {
    case 'INVALID_API_KEY':
      return m.provider_test_err_invalid_key();
    case 'ACCESS_FORBIDDEN':
      return m.provider_test_err_forbidden();
    case 'BASE_URL_NOT_FOUND':
      return m.provider_test_err_url_404();
    case 'QUOTA_EXCEEDED':
      return m.provider_test_err_quota();
    case 'CONNECTION_FAILED':
      return m.provider_test_err_connection();
    case 'MODEL_NOT_FOUND':
      return m.provider_test_err_model_not_found();
    case 'MISSING_API_KEY':
      return m.provider_test_missing_key_desc();
    case 'KEY_DECRYPT_FAILED':
      return m.toast_key_decrypt_failed();
    default:
      return rawFallback || m.provider_test_err_fallback();
  }
}
