# Contributing to OpenGits

Thanks for your interest! Issues and PRs are welcome.

## Setup

```bash
git clone https://github.com/OpenCNM/opengits.git && cd opengits
npm install
cp .env.example .env                     # DATABASE_URL (LLM key 在应用内 BYOK 输入,不走 env)
docker compose up -d db                  # local Postgres on :5433
npx prisma migrate deploy
npm run dev                              # http://localhost:3000
```

## Before you open a PR

CI runs the same gates on every PR — make sure they pass locally first:

```bash
npm run verify:fast     # i18n compile + tsc (client) + anti-hardcode + silent-swallow lint
npm run test:unit       # full unit suite
npm run build           # production build (for larger changes)
```

## Ground rules

- **No hardcoding** — no magic strings/numbers, no raw HEX colors, no inline heuristic lists. File-role/pattern matching belongs in the central `MODULE_ROLE_PATTERNS` registry (`src/engine/language-map.ts`); theme colors use the Tailwind `@theme` variables (`bg-theme-bg`, `text-theme-foreground`, …). Enforced by `npm run lint:hardcode`.
- **Server Components by default** — `"use client"` only where interactivity/browser APIs are required. The anti-hardcoding linter (`scripts/lint-anti-hardcode.mjs`, run by `npm run verify:fast` and `npm run build`) also flags RSC boundary violations (event handlers in server components, raw `<script>` tags).
- **Strict typing** — no `any` / blind assertions; schema changes must keep the Prisma ↔ Zod ↔ TypeScript triad in sync.
- **Commits** — conventional style (`feat(scope): …`, `fix(security): …`), same language as the existing history (Chinese body is fine).

## Where to help

- Browse issues labeled `good first issue`
- New language support / module-role patterns for the ingest engine
- Bilingual README improvements and test coverage expansion

## Security

Do not open public issues for vulnerabilities — see [SECURITY.md](./SECURITY.md).
