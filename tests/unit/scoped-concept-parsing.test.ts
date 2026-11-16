import { describe, it, expect, vi } from 'vitest';
import { parseScopedConcept, runExploreConcept } from '@/lib/mcp/tools/concepts';

describe('parseScopedConcept', () => {
  it('correctly parses owner/repo#concept syntax', () => {
    const res = parseScopedConcept('facebook/react#Hooks');
    expect(res.scope).toBe('facebook/react');
    expect(res.conceptName).toBe('Hooks');
  });

  it('correctly parses repo#concept syntax', () => {
    const res = parseScopedConcept('next.js#App Router');
    expect(res.scope).toBe('next.js');
    expect(res.conceptName).toBe('App Router');
  });

  it('handles leading and trailing whitespace gracefully', () => {
    const res = parseScopedConcept('   vercel/turborepo # Pipeline Caching   ');
    expect(res.scope).toBe('vercel/turborepo');
    expect(res.conceptName).toBe('Pipeline Caching');
  });

  it('returns empty scope for plain concept names', () => {
    const res = parseScopedConcept('Virtual DOM');
    expect(res.scope).toBe('');
    expect(res.conceptName).toBe('Virtual DOM');
  });

  it('splits on the last hash when multiple hashes are present', () => {
    const res = parseScopedConcept('org/repo#module#subconcept');
    expect(res.scope).toBe('org/repo#module');
    expect(res.conceptName).toBe('subconcept');
  });

  it('handles empty or blank string without error', () => {
    const res = parseScopedConcept('   ');
    expect(res.scope).toBe('');
    expect(res.conceptName).toBe('');
  });
});

describe('runExploreConcept scoped routing', () => {
  it('returns missing concept error when empty', async () => {
    const runtime = {
      owner: 'testowner',
      repo: 'testrepo',
      multiRepo: false,
    } as any;

    const res = await runExploreConcept({ concept: '   ' }, runtime);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('Error: "concept" parameter is required');
  });

  it('auto-extracts scope from concept if repository is not passed', async () => {
    const runtime = {
      label: 'Hub',
      owner: 'defaultowner',
      repo: 'defaultrepo',
      multiRepo: true,
      userId: 'u1',
      resolveRepository: vi.fn().mockImplementation(async (ref?: string) => {
        if (ref === 'facebook/react') {
          return {
            owner: 'facebook',
            repo: 'react',
            repository: { id: 'repo-react', owner: 'facebook', repo: 'react' },
          };
        }
        return null;
      }),
    } as any;

    // Resolving a non-existent repo returns not found error mentioning the extracted scope
    const res = await runExploreConcept({ concept: 'nonexistent/repo#SomeConcept' }, runtime);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('nonexistent/repo');
    expect(runtime.resolveRepository).toHaveBeenCalledWith('nonexistent/repo');
  });
});
