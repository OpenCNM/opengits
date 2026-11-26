import { z } from 'zod';

export const RELAY_SECTION_TYPES = ['intro', 'prose', 'code', 'summary'] as const;

export const RelaySectionSchema = z.object({
  type: z.enum(RELAY_SECTION_TYPES),
  heading: z.string().min(1).max(120),
  content: z.string().min(1),
  sourceRef: z.string().max(200).optional(),
});

export const RelayConceptAnchorSchema = z.object({
  term: z.string().min(1).max(80),
  translation: z.string().min(1).max(80),
});

export const RelayTranscriptionSchema = z.object({
  title: z.string().min(1).max(200),
  sections: z.array(RelaySectionSchema).min(1).max(60),
  conceptAnchors: z.array(RelayConceptAnchorSchema).max(30).default([]),
  coverage: z.object({
    sourceSections: z.number().int().min(0),
    coveredSections: z.number().int().min(0),
  }),
});

export type RelayTranscription = z.infer<typeof RelayTranscriptionSchema>;
export type RelaySection = z.infer<typeof RelaySectionSchema>;
