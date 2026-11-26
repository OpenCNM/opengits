# OpenGits

Turn any GitHub repository or web docs into structured web tutorials and Model Context Protocol (MCP) servers for Cursor, Windsurf, and Claude Code.

---

OpenGits parses repositories with a deterministic AST and rule pipeline, producing two outputs:

1. **A readable web tutorial** — Curated chapter outlines, interactive code walkthroughs, visual HotPatch diffs, micro-quizzes, and architectural diagrams, with light, dark, and parchment themes.
2. **An MCP endpoint for AI agents** — Provides Cursor, Windsurf, and Claude Code with deterministic, section-level project knowledge, full-text search, and concept dependency graphs.

```
                  ┌────────────────────────┐
                  │ GitHub Repo / Web Docs │
                  └───────────┬────────────┘
                              │
                    AST & Rule Ingest
                    (0 LLM calls at ingest)
                              │
                  ┌───────────┴────────────┐
                  │ PostgreSQL (FTS + GIN) │
                  └───────────┬────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    Web Tutorials (/docs/...)       MCP Server (/api/mcp/...)
```

## Quick Start

Prerequisites: Node.js 24+ and Docker.

```bash
git clone https://github.com/OpenCNM/opengits.git && cd opengits
cp .env.example .env                     # fill in DATABASE_URL and NEXTAUTH_SECRET
docker compose up -d db                  # local Postgres on :5433
npm install
npx prisma generate && npx prisma migrate deploy
npm run dev                              # http://localhost:3000
```

Or run the full stack in containers (web, Go worker sidecar, Postgres, reverse proxy):

```bash
docker compose up -d                     # http://localhost:3000
```

All optional variables in `.env.example` degrade gracefully when left empty.

## Overview

- **Zero LLM at ingest**: Module detection, directory filtering, and AST chunking run deterministically in seconds. LLM calls are budgeted and used only when drafting chapter narratives and quizzes (with user-supplied BYOK keys).
- **PostgreSQL-native search**: Code symbols, file paths, and API names are indexed directly with PostgreSQL `tsvector` GIN indexes and `pg_trgm`, without requiring a separate vector database.
- **Hierarchical giant repo explorer**: Repositories with 1,000+ files switch to a subsystem architecture map and on-demand drilldowns.
- **Upstream change tracking**: Monitors upstream Git commits, highlights breaking changes in existing chapters, and supports rolling updates while preserving reading progress.

## Architecture

The system consists of a Node.js reader and a Go worker sidecar sharing a single PostgreSQL instance under single-writer partitioning. The admin console is maintained as a separate private repository (opengits-admin).

## Usage

### Web Reader

Import a GitHub repository or documentation site from the web UI to generate an interactive tutorial under `/docs/{owner}/{repo}`.

### Connecting AI Clients (MCP)

Every ingested repository exposes an MCP endpoint at `/api/mcp/{owner}/{repo}`. Generate an access token under **Settings → MCP API Tokens** in the web UI.

### `llms.txt` Endpoints

- Outline: `GET /api/llms-txt/{owner}/{repo}`
- Full Markdown: `GET /api/llms-txt/{owner}/{repo}?full=true`
- Raw Section: `GET /api/docs-content/{owner}/{repo}/{path...}`

## Contributing & Security

- Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting pull requests.
- To report security vulnerabilities, follow the process in [SECURITY.md](./SECURITY.md).

## License

GNU Affero General Public License v3.0 ([AGPL-3.0-or-later](./LICENSE)).
