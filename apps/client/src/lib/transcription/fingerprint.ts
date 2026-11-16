import { resolveTranscriptionPreset } from '@/lib/transcription-presets';

/**
 * 指纹输入的最小结构上下文：完整 DocContext 结构性满足，市场链（update-market
 * jobs/versions）只需按此最小形状构造即可复用同一条解析链。
 */
export type FingerprintDocContext = {
  repositoryId: string;
  path: string;
  repository: {
    gitSha: string | null;
    repoProfile: Record<string, unknown> | null;
  };
};

/**
 * 指纹输入归一（T2.5）：命中预检 / 中继 finalize / 直连 submit 三处必须产出
 * 同一 requestFingerprint，否则互不命中零 LLM 复用。规则：显式 options 优先，
 * 缺省从 repoProfile 兜底（targetLanguage/transcriptionPreset/transcriptionPrompt），
 * teachingDepth 缺省取 preset 默认——指纹因此成为 (repo, path, sha, 参数) 的纯函数，
 * 与调用方（浏览器直连 / 服务端中继 / 队列 / 更新市场）无关。
 */
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
