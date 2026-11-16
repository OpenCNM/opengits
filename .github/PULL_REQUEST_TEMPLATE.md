## What does this PR change?

<!-- A concise description of the change and why it is needed. -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing behavior to change)
- [ ] Refactor (no behavior change)
- [ ] Docs / CI / chore

## Checklist

- [ ] `npm run verify:fast` passes locally (i18n compile + type check + anti-hardcoding lint)
- [ ] `npm run test` passes locally (unit + integration)
- [ ] No hardcoded secrets, raw HEX colors, or magic strings (see [CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules))
- [ ] Data model changes updated the Schema Triad: `prisma/schema.prisma` + Zod schema + TypeScript types
- [ ] Docs updated (README) if user-facing
