import { DisplayRepo } from '@/lib/home-data';
import type { AnnouncementItem } from '@/components/announcement/AnnouncementBanner';

import * as m from '@/paraglide/messages';

export interface GitHubHomeViewProps {
  initialRepos: DisplayRepo[];
  initialMyRepos?: DisplayRepo[];
  userId: string | null;
  hasPreferencesSet?: boolean;
  activeTab?: string;
  sort: string;
  announcements?: AnnouncementItem[];
}

export interface SampleRepoItem {
  label: string;
  url: string;
  isWeb?: boolean;
}

export const SAMPLE_REPOS: SampleRepoItem[] = [
  { label: 'ggml-org/llama.cpp', url: 'https://github.com/ggml-org/llama.cpp', isWeb: false },
  { label: 'vllm-project/vllm', url: 'https://github.com/vllm-project/vllm', isWeb: false },
  { label: 'vercel-labs/vgpu', url: 'https://github.com/vercel-labs/vgpu', isWeb: false },
  { label: 'gpui-component', url: 'https://longbridge.github.io/gpui-component/', isWeb: true },
];
