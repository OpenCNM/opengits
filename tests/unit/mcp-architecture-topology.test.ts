import { describe, it, expect } from 'vitest';
import {
  extractMacroTopologySection,
  renderMacroArchitecture,
  renderSubsystemArchitecture,
  resolveArchitectureTopologyBlock,
  RepoRuntime,
} from '@/lib/mcp/tools/shared';
import { runOutline } from '@/lib/mcp/tools/outline';
import { runExploreConcept } from '@/lib/mcp/tools/concepts';
import { runSearch } from '@/lib/mcp/tools/search';

describe('MCP Native Architecture Topology Projection (C4 L1-L3)', () => {
  const mockRepoWithClusters = {
    id: 'repo-arch-1',
    owner: 'alice',
    repo: 'compiler-demo',
    branch: 'main',
    repoProfile: {
      codeClusters: [
        {
          title: 'Lexer & Scanner',
          directories: ['src/lexer'],
          files: ['src/lexer/token.ts', 'src/lexer/scanner.ts'],
          teachingOrder: 1,
          chapterNo: 1,
          summary: 'Token scanning and lexical analysis',
          cognitive: {
            phase: 'infra',
            rationale: 'Foundation for lexical stream generation',
            goldenSymbols: [
              { name: 'Scanner', kind: 'class', file: 'src/lexer/scanner.ts' },
              { name: 'scanToken', kind: 'function', file: 'src/lexer/scanner.ts' },
            ],
            callFlow: [
              { caller: 'Scanner.scan', callee: 'scanToken' },
            ],
            upstreamModules: [],
            downstreamModules: ['Parser'],
          },
        },
        {
          title: 'Parser',
          directories: ['src/parser'],
          files: ['src/parser/parser.ts', 'src/parser/ast.ts'],
          teachingOrder: 2,
          chapterNo: 2,
          summary: 'Recursive descent parser producing AST',
          cognitive: {
            phase: 'core',
            rationale: 'Core syntax validation and AST tree building',
            goldenSymbols: [
              { name: 'Parser', kind: 'class', file: 'src/parser/parser.ts' },
              { name: 'parseProgram', kind: 'function', file: 'src/parser/parser.ts' },
            ],
            callFlow: [
              { caller: 'Parser.parse', callee: 'parseProgram' },
            ],
            upstreamModules: ['Lexer & Scanner'],
            downstreamModules: [],
          },
        },
      ],
    },
    navTree: [
      { type: 'page', title: 'Chapter 1: Lexer', path: 'ch01-lexer.md' },
      { type: 'page', title: 'Chapter 2: Parser', path: 'ch02-parser.md' },
    ],
    documents: [
      { id: 'doc-1', title: 'Chapter 1: Lexer', path: 'ch01-lexer.md', summary: 'Lexer chapter' },
      { id: 'doc-2', title: 'Chapter 2: Parser', path: 'ch02-parser.md', summary: 'Parser chapter' },
    ],
  };

  const mockPureDocRepo = {
    id: 'repo-doc-only',
    owner: 'bob',
    repo: 'user-manual',
    branch: 'main',
    repoProfile: {},
    navTree: [
      { type: 'page', title: 'Overview', path: 'overview.md' },
    ],
    documents: [
      { id: 'doc-manual', title: 'Overview', path: 'overview.md', summary: 'Manual overview' },
    ],
  };

  const createRuntime = (repoObj: any): RepoRuntime => ({
    label: `${repoObj.owner}/${repoObj.repo}`,
    multiRepo: false,
    resolveRepository: async () => ({
      owner: repoObj.owner,
      repo: repoObj.repo,
      repository: repoObj,
      targetVersionLabel: 'main',
    }),
    listRepositories: async () => [],
  });

  describe('1. extractMacroTopologySection (Pure Function Projection)', () => {
    it('returns empty string when repoProfile has no topology or clusters', () => {
      expect(extractMacroTopologySection(null)).toBe('');
      expect(extractMacroTopologySection({})).toBe('');
      expect(extractMacroTopologySection({ codeClusters: [] })).toBe('');
    });

    it('projects C4 L1 Mermaid flowchart and subsystem list dynamically from codeClusters', () => {
      const section = extractMacroTopologySection(mockRepoWithClusters.repoProfile);
      expect(section).toContain('🏛️ Architecture Topology (C4 L1 System Context):');
      expect(section).toContain('```mermaid');
      expect(section).toContain('flowchart TD');
      expect(section).toContain('Lexer & Scanner');
      expect(section).toContain('Parser');
      expect(section).toContain('### Subsystems & Modules:');
      expect(section).toContain('- **Lexer & Scanner** (2 files) [Infrastructure & Storage]');
      expect(section).toContain('- **Parser** (2 files) [Core Logic]');
    });

    it('prioritizes macroTopologyMermaid if explicitly provided', () => {
      const customMermaid = '```mermaid\nflowchart LR\n  A --> B\n```';
      const section = extractMacroTopologySection({
        macroTopologyMermaid: customMermaid,
      });
      expect(section).toContain('🏛️ Architecture Topology (C4 L1 System Context):');
      expect(section).toContain(customMermaid);
    });
  });

  describe('2. runOutline (C4 L1 Integration in Repo Overview)', () => {
    it('prepends C4 L1 Architecture Topology when repo has code clusters', async () => {
      const runtime = createRuntime(mockRepoWithClusters);
      const res = await runOutline({}, runtime);
      expect(res.isError).toBeFalsy();
      const text = res.content[0].text;
      expect(text).toContain('🏛️ Architecture Topology (C4 L1 System Context):');
      expect(text).toContain('Available Documentation in alice/compiler-demo:');
      expect(text).toContain('explore_concept with action="architecture"');
    });

    it('gracefully omits architecture topology for pure doc repos', async () => {
      const runtime = createRuntime(mockPureDocRepo);
      const res = await runOutline({}, runtime);
      expect(res.isError).toBeFalsy();
      const text = res.content[0].text;
      expect(text).not.toContain('🏛️ Architecture Topology (C4 L1 System Context):');
      expect(text).toContain('Available Documentation in bob/user-manual:');
      expect(text).not.toContain('explore_concept with action="architecture"');
    });
  });

  describe('3. runExploreConcept with action="architecture"', () => {
    it('renders C4 L1 Macro Architecture when concept is empty, "all", "root", or "system"', async () => {
      const runtime = createRuntime(mockRepoWithClusters);

      const resEmpty = await runExploreConcept({ action: 'architecture' }, runtime);
      expect(resEmpty.content[0].text).toContain('# 🏛️ System Architecture Topology (C4 L1 System Context)');
      expect(resEmpty.content[0].text).toContain('Repository: alice/compiler-demo');
      expect(resEmpty.content[0].text).toContain('Lexer & Scanner');

      const resAll = await runExploreConcept({ action: 'architecture', concept: 'all' }, runtime);
      expect(resAll.content[0].text).toContain('# 🏛️ System Architecture Topology (C4 L1 System Context)');

      const resSystem = await runExploreConcept({ action: 'architecture', concept: 'system' }, runtime);
      expect(resSystem.content[0].text).toContain('# 🏛️ System Architecture Topology (C4 L1 System Context)');
    });

    it('renders C4 L2 Subsystem Component Map when targeting a specific subsystem', async () => {
      const runtime = createRuntime(mockRepoWithClusters);
      const res = await runExploreConcept({ action: 'architecture', concept: 'Parser' }, runtime);
      expect(res.isError).toBeFalsy();
      const text = res.content[0].text;
      expect(text).toContain('# 🏛️ Subsystem Architecture (C4 L2 Component Map)');
      expect(text).toContain('Subsystem: Parser (Chapter 2)');
      expect(text).toContain('Repository: alice/compiler-demo');
      expect(text).toContain('Directories: src/parser');
      expect(text).toContain('Files (2): src/parser/parser.ts, src/parser/ast.ts');
      expect(text).toContain('## Component Collaboration & AST Call Flow');
      expect(text).toContain('```mermaid');
      expect(text).toContain('### Verified AST Golden Symbols:');
      expect(text).toContain('`Parser` (class) in `src/parser/parser.ts`');
      expect(text).toContain('### Architectural Rationale:');
      expect(text).toContain('Core syntax validation and AST tree building');
      expect(text).toContain('### Module Dependencies:');
      expect(text).toContain('- Upstream (Prerequisites): Lexer & Scanner');
    });

    it('returns available subsystem list when subsystem is not found', async () => {
      const runtime = createRuntime(mockRepoWithClusters);
      const res = await runExploreConcept({ action: 'architecture', concept: 'unknown-module' }, runtime);
      expect(res.isError).toBeFalsy();
      const text = res.content[0].text;
      expect(text).toContain('Subsystem "unknown-module" not found in architecture topology for alice/compiler-demo.');
      expect(text).toContain('Available subsystems:');
      expect(text).toContain('- Lexer & Scanner');
      expect(text).toContain('- Parser');
    });

    it('returns clear fallback message when called on pure doc repo', async () => {
      const runtime = createRuntime(mockPureDocRepo);
      const res = await runExploreConcept({ action: 'architecture' }, runtime);
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('No code architecture topology available for bob/user-manual (non-code documentation repository).');
    });
  });

  describe('4. resolveArchitectureTopologyBlock & search integration', () => {
    it('resolves macro topology for global architectural queries', () => {
      const block = resolveArchitectureTopologyBlock('alice', 'compiler-demo', mockRepoWithClusters.repoProfile, 'architecture');
      expect(block).toContain('🏛️ Architecture Topology (C4 L1 System Context):');
      expect(block).toContain('Lexer & Scanner');
    });

    it('resolves subsystem topology when query matches subsystem', () => {
      const block = resolveArchitectureTopologyBlock('alice', 'compiler-demo', mockRepoWithClusters.repoProfile, 'Parser');
      expect(block).toContain('# 🏛️ Subsystem Architecture (C4 L2 Component Map)');
      expect(block).toContain('Subsystem: Parser');
    });

    it('returns empty string when query does not match architecture terms or subsystems', () => {
      const block = resolveArchitectureTopologyBlock('alice', 'compiler-demo', mockRepoWithClusters.repoProfile, 'something unrelated');
      expect(block).toBe('');
    });
  });
});
