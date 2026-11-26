export interface ScoutMetadata {
  aiCategory: string;
  aiTags: string;
  paradigm: string;
  parallelTracks: string[];
}

export const DEFAULT_METADATA: ScoutMetadata = {
  aiCategory: 'Others',
  aiTags: '',
  paradigm: 'Engineering',
  parallelTracks: [],
};
