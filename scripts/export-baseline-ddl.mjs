/**
 * Export physical baseline DDL from prisma/schema.prisma for worker-sidecar & sqlc.
 *
 * `prisma migrate diff` emits two constructs that PostgreSQL rejects on a fresh DB:
 * 1. `DocumentChunk.searchVector` as `DEFAULT to_tsvector(..., heading, content)`
 *    (PostgreSQL forbids column references in DEFAULT; must be GENERATED ALWAYS AS ... STORED).
 * 2. `gin_trgm_ops` GIN indexes without `CREATE EXTENSION IF NOT EXISTS pg_trgm;`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = path.join(ROOT_DIR, 'prisma', 'schema.prisma');
const OUTPUT_PATH = path.join(
  ROOT_DIR,
  'services',
  'worker-sidecar',
  'migrations',
  '000001_baseline.sql',
);

const rawDdl = execFileSync(
  'npx',
  [
    'prisma',
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema-datamodel',
    SCHEMA_PATH,
    '--script',
  ],
  { cwd: ROOT_DIR, encoding: 'utf8' },
);

let patched = rawDdl.replace(
  'CREATE SCHEMA IF NOT EXISTS "public";\n',
  'CREATE SCHEMA IF NOT EXISTS "public";\n\n-- Extensions required by trigram GIN indexes (gin_trgm_ops)\nCREATE EXTENSION IF NOT EXISTS pg_trgm;\n',
);

const searchVectorLine =
  '    "searchVector" tsvector DEFAULT to_tsvector(\'simple\'::regconfig, ((COALESCE(heading, \'\'::text) || \' \'::text) || COALESCE(content, \'\'::text))),';
const searchVectorGenerated =
  '    "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector(\'simple\'::regconfig, ((COALESCE(heading, \'\'::text) || \' \'::text) || COALESCE(content, \'\'::text)))) STORED,';

if (!patched.includes(searchVectorLine)) {
  throw new Error('Expected DocumentChunk.searchVector DEFAULT line not found in prisma migrate diff output');
}
patched = patched.replace(searchVectorLine, searchVectorGenerated);

fs.writeFileSync(OUTPUT_PATH, patched, 'utf8');
console.log(`Exported baseline DDL to ${path.relative(ROOT_DIR, OUTPUT_PATH)}`);
