import { randomUUID } from "node:crypto";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  allSentences,
  type Paper,
  type ReviewFinding,
  type ReviewResult,
  sentenceCitationIds,
  sentenceText,
  type WorkSource,
} from "@/lib/domain";
import { getOpenAI, hasModelAccess, modelName } from "@/lib/model";
import { discoverWorks, resolveReferences } from "@/lib/scholarly/academic-search";
import { mergeSources, normalizedDoi, normalizedTitle } from "@/lib/scholarly/shared";

const ModelReviewSchema = z.strictObject({
  citationMatches: z.array(
    z.strictObject({
      sentenceId: z.string(),
      sourceId: z.string(),
      verdict: z.enum([
        "SUPPORTED",
        "PARTIALLY_SUPPORTED",
        "CONTRADICTED",
        "INSUFFICIENT_ABSTRACT",
      ]),
      rationale: z.string(),
      evidence: z.string(),
    }),
  ),
  missingWork: z.array(
    z.strictObject({
      sentenceId: z.string(),
      sourceId: z.string(),
      rationale: z.string(),
    }),
  ),
});

interface ClaimInput {
  sentenceId: string;
  text: string;
  citedSourceIds: string[];
}

export async function reviewPaper(
  documentId: string,
  versionId: string,
  paper: Paper,
): Promise<ReviewResult> {
  const sentences = allSentences(paper).filter((sentence) => sentenceText(sentence).length >= 35);
  const cited = sentences.filter((sentence) => sentenceCitationIds(sentence).length > 0).slice(0, 10);
  const citedReferenceIds = [...new Set(cited.flatMap(sentenceCitationIds))];
  const references = paper.references.filter((reference) => citedReferenceIds.includes(reference.id));
  const resolution = await resolveReferences(references);

  const discoveryClaims = sentences
    .filter((sentence) => sentenceCitationIds(sentence).length === 0)
    .slice(0, 3);
  const query = buildDiscoveryQuery(paper, discoveryClaims.map(sentenceText));
  const seedIds = resolution.sources
    .map((source) => source.providerIds.semanticScholar)
    .filter((id): id is string => Boolean(id));
  const discovery = await discoverWorks(query, seedIds);
  const discovered = excludeExistingWorks(discovery.sources, paper).slice(0, 12);
  const sources = mergeSources([...resolution.sources, ...discovered]);
  const claims: ClaimInput[] = cited.map((sentence) => ({
    sentenceId: sentence.id,
    text: sentenceText(sentence),
    citedSourceIds: sentenceCitationIds(sentence)
      .map((referenceId) => resolution.byReferenceId.get(referenceId)?.id)
      .filter((id): id is string => Boolean(id)),
  }));
  const missingClaims: ClaimInput[] = discoveryClaims.map((sentence) => ({
    sentenceId: sentence.id,
    text: sentenceText(sentence),
    citedSourceIds: [],
  }));
  let engine: ReviewResult["engine"] = hasModelAccess() ? "model" : "deterministic-fallback";
  let usedModelFallback = false;
  let findings: ReviewFinding[];
  if (hasModelAccess()) {
    try {
      findings = await modelFindings(claims, missingClaims, sources);
    } catch {
      engine = "deterministic-fallback";
      usedModelFallback = true;
      findings = fallbackFindings(claims, missingClaims, sources);
    }
  } else {
    findings = fallbackFindings(claims, missingClaims, sources);
  }
  return {
    id: randomUUID(),
    documentId,
    versionId,
    createdAt: new Date().toISOString(),
    engine,
    findings,
    sources,
    providerStatus: {
      semanticScholar: combineStatus(
        resolution.providerState.semanticScholar,
        discovery.providerState.semanticScholar,
      ),
      openAlex: combineStatus(resolution.providerState.openAlex, discovery.providerState.openAlex),
    },
    limitations: [
      "Citation support is assessed from available abstracts, not full text.",
      "A missing abstract is reported as insufficient evidence, never as contradiction.",
      "Suggested work is a ranked retrieval result and still requires author judgment.",
      ...(engine === "deterministic-fallback"
        ? [
            usedModelFallback
              ? "The configured model was unavailable; transparent lexical heuristics were used."
              : "OPENAI_API_KEY is not configured; transparent lexical heuristics were used.",
          ]
        : []),
    ],
  };
}

async function modelFindings(
  citedClaims: ClaimInput[],
  missingClaims: ClaimInput[],
  sources: WorkSource[],
): Promise<ReviewFinding[]> {
  const sourceCatalog = sources.map((source) => ({
    id: source.id,
    title: source.title,
    abstract: source.abstract,
    year: source.year,
  }));
  const response = await getOpenAI().responses.parse({
    model: modelName(),
    input: [
      {
        role: "system",
        content:
          "You are a conservative academic reviewer. Use only supplied source IDs. Judge citation support only from the supplied abstract. Evidence must be an exact contiguous substring of that abstract. If the abstract is absent or insufficient, return INSUFFICIENT_ABSTRACT. Missing-work suggestions must select a supplied source that directly relates to the claim. Do not invent metadata or references.",
      },
      {
        role: "user",
        content: JSON.stringify({ citedClaims, missingClaims, sources: sourceCatalog }),
      },
    ],
    text: { format: zodTextFormat(ModelReviewSchema, "paper_review") },
  });
  const parsed = response.output_parsed;
  return parsed ? validateModelFindings(parsed, citedClaims, missingClaims, sources) : [];
}

function validateModelFindings(
  output: z.infer<typeof ModelReviewSchema>,
  citedClaims: ClaimInput[],
  missingClaims: ClaimInput[],
  sources: WorkSource[],
): ReviewFinding[] {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const citedMap = new Map(citedClaims.map((claim) => [claim.sentenceId, claim]));
  const missingMap = new Map(missingClaims.map((claim) => [claim.sentenceId, claim]));
  const citationMatches = output.citationMatches.flatMap((finding): ReviewFinding[] => {
    const source = sourceMap.get(finding.sourceId);
    const claim = citedMap.get(finding.sentenceId);
    if (!source || !claim || !claim.citedSourceIds.includes(source.id)) return [];
    const needsEvidence = finding.verdict !== "INSUFFICIENT_ABSTRACT";
    if (needsEvidence && (!source.abstract || !source.abstract.includes(finding.evidence))) return [];
    return [
      {
        id: randomUUID(),
        kind: "citation-match",
        verdict: finding.verdict,
        severity: finding.verdict === "CONTRADICTED" ? "action" : finding.verdict === "SUPPORTED" ? "information" : "attention",
        title: verdictTitle(finding.verdict),
        rationale: finding.rationale,
        sentenceId: finding.sentenceId,
        sourceIds: [source.id],
        evidence: finding.evidence || undefined,
      },
    ];
  });
  const missingWork = output.missingWork.flatMap((finding): ReviewFinding[] => {
    const source = sourceMap.get(finding.sourceId);
    if (!source || !missingMap.has(finding.sentenceId)) return [];
    return [
      {
        id: randomUUID(),
        kind: "missing-work",
        severity: "attention",
        title: "Relevant work may be missing",
        rationale: finding.rationale,
        sentenceId: finding.sentenceId,
        sourceIds: [source.id],
      },
    ];
  });
  return [...citationMatches, ...missingWork];
}

function fallbackFindings(
  citedClaims: ClaimInput[],
  missingClaims: ClaimInput[],
  sources: WorkSource[],
): ReviewFinding[] {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const matches = citedClaims.flatMap((claim): ReviewFinding[] => {
    const source = claim.citedSourceIds.map((id) => sourceMap.get(id)).find(Boolean);
    if (!source) return [];
    const score = source.abstract ? lexicalOverlap(claim.text, source.abstract) : 0;
    const verdict = !source.abstract
      ? "INSUFFICIENT_ABSTRACT"
      : score >= 0.3
        ? "SUPPORTED"
        : score >= 0.12
          ? "PARTIALLY_SUPPORTED"
          : "INSUFFICIENT_ABSTRACT";
    return [
      {
        id: randomUUID(),
        kind: "citation-match",
        verdict,
        severity: verdict === "SUPPORTED" ? "information" : "attention",
        title: verdictTitle(verdict),
        rationale:
          verdict === "SUPPORTED"
            ? "The claim and available abstract share substantial technical language."
            : "The available abstract does not provide enough direct evidence for a confident judgment.",
        sentenceId: claim.sentenceId,
        sourceIds: [source.id],
        evidence: source.abstract ? firstSentence(source.abstract) : undefined,
      },
    ];
  });
  const alreadyUsed = new Set(citedClaims.flatMap((claim) => claim.citedSourceIds));
  const suggestions = missingClaims.slice(0, 2).flatMap((claim, index): ReviewFinding[] => {
    const source = sources.filter((candidate) => !alreadyUsed.has(candidate.id))[index];
    if (!source) return [];
    return [
      {
        id: randomUUID(),
        kind: "missing-work",
        severity: "attention",
        title: "Relevant work may be missing",
        rationale: `This retrieved work overlaps with the claim and should be reviewed before inclusion: ${source.title}.`,
        sentenceId: claim.sentenceId,
        sourceIds: [source.id],
      },
    ];
  });
  return [...matches, ...suggestions];
}

function buildDiscoveryQuery(paper: Paper, claims: string[]): string {
  const section = paper.sections.find((candidate) => candidate.title)?.title ?? "";
  const fallback = paper.abstract.flatMap((paragraph) => paragraph.sentences).map(sentenceText).join(" ");
  return [paper.title, section, claims.join(" ") || fallback].filter(Boolean).join(". ").slice(0, 1_800);
}

function excludeExistingWorks(sources: WorkSource[], paper: Paper): WorkSource[] {
  const existingDois = new Set(paper.references.map((reference) => normalizedDoi(reference.csl.DOI)).filter(Boolean));
  const existingTitles = new Set(paper.references.map((reference) => normalizedTitle(reference.csl.title ?? "")).filter(Boolean));
  return sources.filter(
    (source) =>
      (!source.doi || !existingDois.has(normalizedDoi(source.doi))) &&
      !existingTitles.has(normalizedTitle(source.title)),
  );
}

function lexicalOverlap(left: string, right: string): number {
  const leftTokens = meaningfulTokens(left);
  const rightTokens = meaningfulTokens(right);
  if (!leftTokens.size) return 0;
  return [...leftTokens].filter((token) => rightTokens.has(token)).length / leftTokens.size;
}

function meaningfulTokens(value: string): Set<string> {
  const stop = new Set(["this", "that", "with", "from", "have", "were", "been", "into", "their", "which", "using"]);
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z]{4,}/g)
      ?.filter((token) => !stop.has(token)) ?? [],
  );
}

function firstSentence(value: string): string {
  return value.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? value.slice(0, 240);
}

function verdictTitle(verdict: ReviewFinding["verdict"]): string {
  if (verdict === "SUPPORTED") return "Citation appears to support this claim";
  if (verdict === "PARTIALLY_SUPPORTED") return "Citation only partially supports this claim";
  if (verdict === "CONTRADICTED") return "Citation appears to contradict this claim";
  return "Available abstract is insufficient";
}

function combineStatus(
  left: "ok" | "partial" | "unavailable",
  right: "ok" | "partial" | "unavailable",
): "ok" | "partial" | "unavailable" {
  if (left === "ok" && right === "ok") return "ok";
  if (left === "unavailable" && right === "unavailable") return "unavailable";
  return "partial";
}
