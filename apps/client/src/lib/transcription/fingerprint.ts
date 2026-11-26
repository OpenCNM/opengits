import { resolveTranscriptionPreset } from '@/lib/transcription-presets';

export type FingerprintDocContext = {
  repositoryId: string;
  path: string;
  repository: {
    gitSha: string | null;
    repoProfile: Record<string, unknown> | null;
  };
};

// Preflight, relay finalize, and direct submit must produce identical normalized inputs for cache reuse.
export function fingerprintInputsFor(
  doc: FingerprintDocContext,
  model: string,
  options: {
    targetLanguage?: string;
    transcriptionPreset?: string;
    teachingDepth?: string;
    aiCondensation?: string;
    customPrompt?: string;
  },
) {
  const profile = doc.repository.repoProfile ?? {};
  const profileStr = (key: string): string | undefined => {
    const v = profile[key];
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
  };
  const transcriptionPreset = options.transcriptionPreset ?? profileStr('transcriptionPreset');
  const preset = resolveTranscriptionPreset(transcriptionPreset);
  return {
    repositoryId: doc.repositoryId,
    path: doc.path,
    gitSha: doc.repository.gitSha,
    lang: options.targetLanguage ?? profileStr('targetLanguage') ?? '',
    model,
    preset: transcriptionPreset,
    teachingDepth: options.teachingDepth ?? preset.defaults?.teachingDepth,
    aiCondensation: options.aiCondensation ?? preset.defaults?.aiCondensation,
    customPrompt: options.customPrompt ?? profileStr('transcriptionPrompt'),
  };
}
