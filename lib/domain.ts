import { z } from "zod";

export const DocumentStatusSchema = z.enum([
  "UPLOADED",
  "PARSING",
  "READY",
  "REVIEWING",
  "EDITING",
  "EXPORTING",
  "NEEDS_OCR",
  "FAILED",
]);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const CslNameSchema = z.strictObject({
  family: z.string().optional(),
  given: z.string().optional(),
  literal: z.string().optional(),
});

export const CslItemSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    title: z.string().optional(),
    author: z.array(CslNameSchema).optional(),
    editor: z.array(CslNameSchema).optional(),
    issued: z
      .strictObject({
        "date-parts": z.array(z.array(z.number().int())),
      })
      .optional(),
    "container-title": z.string().optional(),
    volume: z.string().optional(),
    issue: z.string().optional(),
    page: z.string().optional(),
    publisher: z.string().optional(),
    DOI: z.string().optional(),
    URL: z.string().url().optional(),
  })
  .passthrough();
export type CslItem = z.infer<typeof CslItemSchema>;

export const TextNodeSchema = z.strictObject({
  type: z.literal("text"),
  value: z.string(),
});

export const CitationNodeSchema = z.strictObject({
  type: z.literal("citation"),
  anchorId: z.string().min(1),
  referenceIds: z.array(z.string().min(1)).min(1),
  raw: z.string(),
  coordinates: z.string().optional(),
});
export type CitationNode = z.infer<typeof CitationNodeSchema>;

export const InlineNodeSchema = z.discriminatedUnion("type", [
  TextNodeSchema,
  CitationNodeSchema,
]);
export type InlineNode = z.infer<typeof InlineNodeSchema>;

export const SentenceSchema = z.strictObject({
  id: z.string().min(1),
  nodes: z.array(InlineNodeSchema),
});
export type Sentence = z.infer<typeof SentenceSchema>;

export const ParagraphSchema = z.strictObject({
  id: z.string().min(1),
  sentences: z.array(SentenceSchema),
});
export type Paragraph = z.infer<typeof ParagraphSchema>;

export const SectionSchema = z.strictObject({
  id: z.string().min(1),
  parentId: z.string().optional(),
  level: z.number().int().min(1),
  title: z.string(),
  paragraphs: z.array(ParagraphSchema),
});
export type Section = z.infer<typeof SectionSchema>;

export const ReferenceRecordSchema = z.strictObject({
  id: z.string().min(1),
  csl: CslItemSchema,
  raw: z.string().optional(),
  status: z.enum(["parsed", "resolved", "ambiguous", "unresolved"]),
  confidence: z.number().min(0).max(1),
  providerIds: z.record(z.string(), z.string()).default({}),
});
export type ReferenceRecord = z.infer<typeof ReferenceRecordSchema>;

export const ParseWarningSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  referenceId: z.string().optional(),
  anchorId: z.string().optional(),
});
export type ParseWarning = z.infer<typeof ParseWarningSchema>;

export const PaperSchema = z.strictObject({
  schemaVersion: z.literal(1),
  title: z.string(),
  authors: z.array(z.string()),
  abstract: z.array(ParagraphSchema),
  sections: z.array(SectionSchema),
  references: z.array(ReferenceRecordSchema),
  warnings: z.array(ParseWarningSchema),
  citationStyle: z.strictObject({
    family: z.enum(["numeric", "author-date", "unknown"]),
    cslId: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  provenance: z.strictObject({
    parser: z.literal("grobid"),
    parserVersion: z.string(),
    sourceSha256: z.string(),
    parsedAt: z.string().datetime(),
  }),
});
export type Paper = z.infer<typeof PaperSchema>;

export const WorkSourceSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  authors: z.array(z.string()),
  year: z.number().int().optional(),
  abstract: z.string().nullable(),
  doi: z.string().optional(),
  url: z.string().url(),
  providerIds: z.record(z.string(), z.string()),
  providers: z.array(z.enum(["semantic-scholar", "openalex"])).min(1),
  retrievalMethod: z.enum([
    "exact-id",
    "title-search",
    "semantic-search",
    "seed-recommendation",
    "keyword-fallback",
  ]),
  csl: CslItemSchema,
});
export type WorkSource = z.infer<typeof WorkSourceSchema>;

export const ReviewFindingSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["citation-match", "missing-work"]),
  verdict: z
    .enum(["SUPPORTED", "PARTIALLY_SUPPORTED", "CONTRADICTED", "INSUFFICIENT_ABSTRACT"])
    .optional(),
  severity: z.enum(["action", "attention", "information"]),
  title: z.string(),
  rationale: z.string(),
  sentenceId: z.string(),
  referenceId: z.string().optional(),
  sourceIds: z.array(z.string()),
  evidence: z.string().optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewResultSchema = z.strictObject({
  id: z.string(),
  documentId: z.string(),
  versionId: z.string(),
  createdAt: z.string().datetime(),
  engine: z.enum(["model", "deterministic-fallback"]),
  findings: z.array(ReviewFindingSchema),
  sources: z.array(WorkSourceSchema),
  providerStatus: z.strictObject({
    semanticScholar: z.enum(["ok", "partial", "unavailable"]),
    openAlex: z.enum(["ok", "partial", "unavailable"]),
  }),
  limitations: z.array(z.string()),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const ReplaceSentenceOperationSchema = z.strictObject({
  type: z.literal("replace-sentence"),
  sentenceId: z.string(),
  beforeText: z.string(),
  afterText: z.string(),
});

export const AddCitationOperationSchema = z.strictObject({
  type: z.literal("add-citation"),
  sentenceId: z.string(),
  source: WorkSourceSchema,
});

export const AddSourcedSentenceOperationSchema = z.strictObject({
  type: z.literal("add-sourced-sentence"),
  sectionId: z.string(),
  afterSentenceId: z.string().optional(),
  text: z.string(),
  sources: z.array(WorkSourceSchema).min(1),
});

export const EditOperationSchema = z.discriminatedUnion("type", [
  ReplaceSentenceOperationSchema,
  AddCitationOperationSchema,
  AddSourcedSentenceOperationSchema,
]);
export type EditOperation = z.infer<typeof EditOperationSchema>;

export const EditProposalSchema = z.strictObject({
  id: z.string(),
  documentId: z.string(),
  baseVersionId: z.string(),
  command: z.string(),
  summary: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  engine: z.enum(["model", "deterministic-fallback"]),
  operations: z.array(EditOperationSchema).min(1),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
});
export type EditProposal = z.infer<typeof EditProposalSchema>;

export const DocumentSnapshotSchema = z.strictObject({
  id: z.string(),
  filename: z.string(),
  status: DocumentStatusSchema,
  currentVersionId: z.string().nullable(),
  versionCount: z.number().int().nonnegative(),
  paper: PaperSchema.nullable(),
  review: ReviewResultSchema.nullable(),
  proposal: EditProposalSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  error: z
    .strictObject({
      code: z.string(),
      message: z.string(),
    })
    .nullable(),
});
export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>;

export function sentenceText(sentence: Sentence): string {
  return sentence.nodes
    .filter((node): node is z.infer<typeof TextNodeSchema> => node.type === "text")
    .map((node) => node.value)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function sentenceCitationIds(sentence: Sentence): string[] {
  return sentence.nodes.flatMap((node) => (node.type === "citation" ? node.referenceIds : []));
}

export function allSentences(paper: Paper): Array<Sentence & { sectionId?: string }> {
  const abstract = paper.abstract.flatMap((paragraph) =>
    paragraph.sentences.map((sentence) => ({ ...sentence, sectionId: "abstract" })),
  );
  const body = paper.sections.flatMap((section) =>
    section.paragraphs.flatMap((paragraph) =>
      paragraph.sentences.map((sentence) => ({ ...sentence, sectionId: section.id })),
    ),
  );
  return [...abstract, ...body];
}
