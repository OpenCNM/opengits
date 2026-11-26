import { z } from 'zod';

type ChapterAssetKind = 'exercise' | 'example' | 'answer' | 'resource';

interface ChapterMapAsset {
  path: string;
  kind: ChapterAssetKind;
}

export interface ChapterMapEntry {
  order: number;
  title: string;
  mainPath: string;
  assetPaths: ChapterMapAsset[];
}

// Kept in lockstep with Go ValidateChapterMap; per-field .catch() prevents fast-model drift from failing the whole map.
export const chapterMapSchema = z.object({
  isTutorial: z
    .boolean()
    .catch(false)
    .describe('True only if the repository contains an ordered tutorial/book chapter sequence.'),
  chapters: z
    .array(
      z.object({
        order: z.number().catch(0).describe('Reading order of the chapter, starting at 1.'),
        title: z
          .string()
          .catch('')
          .describe('Chapter title in the document language; derive from content or filename.'),
        mainPath: z
          .string()
          .catch('')
          .describe('Repository path of the chapter main reading file, copied VERBATIM from the candidate list.'),
        assetPaths: z
          .array(
            z.object({
              path: z.string().catch(''),
              kind: z.enum(['exercise', 'example', 'answer', 'resource']).catch('resource'),
            })
          )
          .catch([])
          .describe('Auxiliary files belonging to this chapter: labs, exercises, examples, answer keys, resources.'),
      })
    )
    .catch([]),
});
