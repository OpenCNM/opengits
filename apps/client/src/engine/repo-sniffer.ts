import type { ChapterMapEntry } from './chapter-map';
import { ENGINE_CONFIG } from '../lib/config';
import { ScaleDecision, RepoScale, MonorepoVolume } from '../types/explorer';

export type { ScaleDecision, RepoScale, MonorepoVolume };

export type IngestMode = 'text_only' | 'code_only' | 'hybrid';

export interface DocCodeRatio {
  docFiles: number;
  codeFiles: number;
  otherFiles: number;
  totalFiles: number;
  ratio: number;
  codeExtensions: Record<string, number>;
  docExtensions: Record<string, number>;
  codeBytes?: number;
  docBytes?: number;
}

export interface CodebaseProfile {
  primaryLanguages: string[];
  entryPoints?: string[];
  framework?: string;
  coreModules?: string[];
  examplePaths?: string[];
  hasTests?: boolean;
  testFramework?: string;
  architectureStyle?: 'monorepo' | 'layered' | 'microservice' | 'single_package' | 'unknown';
  moduleStructure?: 'monolith' | 'monorepo' | 'flat' | 'layered';
  docStyle?: 'book' | 'api-reference' | 'narrative' | 'minimal';
  recommendedPedagogyLevel?: 'concept-first' | 'code-first' | 'balanced';
  keyAbstractions?: string[];
  moduleCount?: number;
  estimatedPedagogicalTime?: number;
  budgetTier?: 'full' | 'smart_sample' | 'entry_trace';
}

export interface RepoProfile {
  tier: 'S' | 'A' | 'B' | 'C' | 'D';
  repoType: 'textbook' | 'course' | 'docs' | 'codebase' | 'notebook';
  description?: string;
  descriptionZh?: string;
  descriptionEn?: string;
  
  ingestMode: IngestMode;
  docCodeRatio: DocCodeRatio;
  codebaseProfile?: CodebaseProfile;

  textRoot: string | null;
  labRoots: string[];
  chapterCount: number;

  chapterMap?: ChapterMapEntry[];
  profileVersion?: number;

  globalAssets: {
    pdfs: { path: string; size: number; lang?: string }[];
    translations: { lang: string; dir: string }[];
    buildScripts: string[];
    misc: string[];
  };

  chapterAssets?: Record<string, { path: string; type: string }[]>;
  
  answerFile: string | null;
  
  hasTranslations: boolean;
  translationRoots: string[];
  primaryLanguage?: string;

  ingestPrefix?: string;
  
  excludeFromNav: string[];

  semanticTags: Record<string, 'migration' | 'answer' | 'config' | 'meta' | 'content'>;

  isTreeTruncated?: boolean;

  volumes?: MonorepoVolume[];
}

export interface GitHubNode {
  path: string;
  type: 'tree' | 'blob';
  size?: number;
}

// Escalate text_only repos with substantial code bytes to LLM arbitration so codebases with docs/ aren't locked out.
export function isIngestModeGrayZone(profile: Pick<RepoProfile, 'ingestMode' | 'docCodeRatio'>): boolean {
  if (profile.ingestMode !== 'text_only') return false;
  const { docFiles, codeFiles, codeBytes } = profile.docCodeRatio;
  return (
    codeFiles >= ENGINE_CONFIG.sniffer.grayZoneMinCodeFiles &&
    (codeBytes ?? 0) >= ENGINE_CONFIG.sniffer.grayZoneMinCodeBytes &&
    docFiles >= 5
  );
}
