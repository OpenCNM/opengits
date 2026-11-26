# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `main` (latest release) | ✅ |
| older commits | ❌ — please update before reporting |

## Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

Email: **security@opengits.org**

Include if possible:

- Affected endpoint / file / commit hash
- Reproduction steps or PoC
- Impact assessment

We aim to respond within **72 hours** and will credit reporters (opt-in) in release notes after a fix ships.

## Security Model (what we already enforce)

- **Fail-fast secrets**: production refuses to boot with a missing `NEXTAUTH_SECRET` (no insecure fallbacks)
- **Auth wall**: all `/api/**` (except auth/MCP-with-token/health) go through the `src/proxy.ts` JWT gate; admin APIs additionally require an active `AdminUser`. Known public exceptions: auth callbacks, `/api/health`, `/api/dissect` (public URL inspection), and llms.txt/docs-content content endpoints.
- **MCP auth & quotas**: unified `request-guard` (Bearer token / session → role → ban / RPM / daily quota) on every tool-execution endpoint; 401s carry `WWW-Authenticate: Bearer`
- **Content sanitization**: AST sanitizer is fail-closed (never persists unsanitized content); Mermaid renders at `securityLevel: antiscript` with a shared XSS guard
- **Audit trail**: admin actions land in `AdminAuditLog`; MCP calls in privacy-safe `McpCallLog` (no query strings, no user linkage)
