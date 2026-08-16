import { randomUUID } from "node:crypto";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  type EditOperation,
  type EditProposal,
  type Paper,
  PaperSchema,
  type Section,
  type Sentence,
  sentenceCitationIds,
  sentenceText,
  type WorkSource,
} from "@/lib/domain";
import { AppError } from "@/lib/errors";
import { assertCitationIntegrity, assertProposalOperations } from "@/lib/invariants";
import { getOpenAI, hasModelAccess, modelName } from "@/lib/model";
import { discoverWorks } from "@/lib/scholarly/academic-search";
import { isUploadedPaper, normalizedDoi, normalizedTitle } from "@/lib/scholarly/shared";

const PlannerSchema = z.strictObject({
  intent: z.enum(["SHORTEN_SECTION", "ADD_CITATIONS", "ADD_SOURCED_CLAIM", "UNSUPPORTED"]),
  sectionId: z.string(),
  goal: z.string(),
});

const RewriteSchema = z.strictObject({
  rewrites: z.array(z.strictObject({ sentenceId: z.string(), text: z.string() })),
});

const SourcedClaimSchema = z.strictObject({
  sourceId: z.string(),
  text: z.string(),
});

const CitationMatchesSchema = z.strictObject({
  matches: z.array(z.strictObject({
    sentenceId: z.string(),
    sourceId: z.string(),
    rationale: z.string(),
    evidence: z.string(),
  })),
});

type EditPlan = z.infer<typeof PlannerSchema>;

export async function proposeEdit(
  documentId: string,
  versionId: string,
  paper: Paper,
  command: string,
): Promise<EditProposal> {
  if (!command.trim()) throw new AppError("command_required", "Describe the change you want.", 400);
  const { plan, engine } = await selectPlan(command, paper);
  if (plan.intent === "UNSUPPORTED") {
    throw new AppError(
      "unsupported_edit",
      "This version supports shortening a section, adding citations, and adding one sourced claim.",
      422,
    );
  }
  const section = resolveSection(plan.sectionId, paper);
  const operations = await executePlan(plan, section, paper);
  if (!operations.length) throw new AppError("no_edit_proposed", "No safe change could be proposed.", 422);
  assertProposalOperations(operations);
  return {
    id: randomUUID(),
    documentId,
    baseVersionId: versionId,
    command,
    summary: proposalSummary(plan, section, operations.length),
    status: "pending",
    engine,
    operations,
    createdAt: new Date().toISOString(),
  };
}

async function selectPlan(
  command: string,
  paper: Paper,
): Promise<{ plan: EditPlan; engine: EditProposal["engine"] }> {
  if (!hasModelAccess()) {
    return { plan: fallbackPlan(command, paper), engine: "deterministic-fallback" };
  }
  try {
    return { plan: await planWithModel(command, paper), engine: "model" };
  } catch {
    return { plan: fallbackPlan(command, paper), engine: "deterministic-fallback" };
  }
}

export function applyProposal(paper: Paper, operations: EditOperation[]): Paper {
  assertProposalOperations(operations);
  const next = structuredClone(paper);
  for (const operation of operations) {
    if (operation.type === "replace-sentence") applySentenceRewrite(next, operation);
    if (operation.type === "add-citation") applyCitation(next, operation);
    if (operation.type === "add-sourced-sentence") applySourcedSentence(next, operation);
  }
  const validated = PaperSchema.parse(next);
  assertCitationIntegrity(paper, validated);
  return validated;
}

async function planWithModel(command: string, paper: Paper): Promise<EditPlan> {
  const sections = [
    { id: "abstract", title: "Abstract" },
    ...paper.sections.map((section) => ({ id: section.id, title: section.title })),
  ];
  const response = await getOpenAI().responses.parse({
    model: modelName(),
    input: [
      {
        role: "system",
        content:
          "Translate an author command into one supported paper edit. Select only a supplied section ID. SHORTEN_SECTION compresses existing prose without new claims. ADD_CITATIONS attaches verified sources to existing claims. ADD_SOURCED_CLAIM adds one claim derived from a verified abstract. Return UNSUPPORTED for structural rewrites, citation removal, or ambiguous commands.",
      },
      { role: "user", content: JSON.stringify({ command, sections }) },
    ],
    text: { format: zodTextFormat(PlannerSchema, "edit_plan") },
  });
  return response.output_parsed ?? fallbackPlan(command, paper);
}

function fallbackPlan(command: string, paper: Paper): EditPlan {
  const normalized = command.toLowerCase();
  const sectionId = matchSectionId(normalized, paper);
  if (/short|condens|concise|tighten|reduce/.test(normalized)) {
    return { intent: "SHORTEN_SECTION", sectionId, goal: command };
  }
  if (/add.*claim|new.*claim|include.*finding/.test(normalized)) {
    return { intent: "ADD_SOURCED_CLAIM", sectionId, goal: command };
  }
  if (/citation|cite|references?|support.*method|related work/.test(normalized)) {
    return { intent: "ADD_CITATIONS", sectionId, goal: command };
  }
  return { intent: "UNSUPPORTED", sectionId, goal: command };
}

async function executePlan(plan: EditPlan, section: Section, paper: Paper): Promise<EditOperation[]> {
  if (plan.intent === "SHORTEN_SECTION") return proposeShortening(section);
  if (plan.intent === "ADD_CITATIONS") return proposeCitations(section, paper, plan.goal);
  if (plan.intent === "ADD_SOURCED_CLAIM") return proposeSourcedClaim(section, paper, plan.goal);
  return [];
}

async function proposeShortening(section: Section): Promise<EditOperation[]> {
  const candidates = section.paragraphs
    .flatMap((paragraph) => paragraph.sentences)
    .filter((sentence) => sentenceText(sentence).length >= 90)
    .slice(0, 6);
  if (!candidates.length) return [];
  const rewrites = hasModelAccess()
    ? await rewriteWithModel(candidates).catch(() => fallbackRewrites(candidates))
    : fallbackRewrites(candidates);
  return rewrites.flatMap((rewrite): EditOperation[] => {
    const sentence = candidates.find((candidate) => candidate.id === rewrite.sentenceId);
    if (!sentence) return [];
    const beforeText = sentenceText(sentence);
    const afterText = rewrite.text.replace(/\s+/g, " ").trim();
    if (!afterText || afterText.length >= beforeText.length || afterText.length < beforeText.length * 0.42) {
      return [];
    }
    return [{ type: "replace-sentence", sentenceId: sentence.id, beforeText, afterText }];
  });
}

async function rewriteWithModel(sentences: Sentence[]) {
  const response = await getOpenAI().responses.parse({
    model: modelName(),
    input: [
      {
        role: "system",
        content:
          "Shorten each sentence while preserving its exact factual meaning. Do not introduce facts, citations, names, numbers, or claims. Return only sentence IDs and revised plain text; citation anchors are maintained separately by application code.",
      },
      {
        role: "user",
        content: JSON.stringify(sentences.map((sentence) => ({ id: sentence.id, text: sentenceText(sentence) }))),
      },
    ],
    text: { format: zodTextFormat(RewriteSchema, "sentence_rewrites") },
  });
  return response.output_parsed?.rewrites ?? [];
}

function fallbackRewrites(sentences: Sentence[]): Array<{ sentenceId: string; text: string }> {
  return sentences.map((sentence) => ({
    sentenceId: sentence.id,
    text: compressText(sentenceText(sentence)),
  }));
}

async function proposeCitations(section: Section, paper: Paper, goal: string): Promise<EditOperation[]> {
  const targets = section.paragraphs
    .flatMap((paragraph) => paragraph.sentences)
    .filter((sentence) => sentenceText(sentence).length >= 45 && sentenceCitationIds(sentence).length === 0)
    .slice(0, 8);
  if (!targets.length) {
    throw new AppError("no_uncited_claims", "No uncited claims were found in that section.", 422);
  }
  const query = citationDiscoveryQuery(paper, section, goal, targets);
  const discovery = await discoverWorks(query, []);
  const candidates = excludeExisting(discovery.sources, paper)
    .filter((source) => source.abstract)
    .slice(0, 8);
  if (!candidates.length) {
    throw new AppError("no_sources_found", "The academic providers returned no verifiable sources.", 422);
  }
  const matches = await selectCitationMatches(targets, candidates);
  if (!matches.length) {
    throw new AppError(
      "no_supported_citations",
      "Sources were found, but none had abstract evidence matching an uncited claim in that section.",
      422,
    );
  }
  return matches;
}

async function selectCitationMatches(
  targets: Sentence[],
  sources: WorkSource[],
): Promise<Array<Extract<EditOperation, { type: "add-citation" }>>> {
  if (hasModelAccess()) {
    try {
      const response = await getOpenAI().responses.parse({
        model: modelName(),
        input: [
          {
            role: "system",
            content:
              "Match each claim to at most one supplied source. A match is valid only when the supplied abstract supports the claim's core assertion, not merely the same broad topic. Explain the specific connection in one short sentence and copy one exact contiguous abstract excerpt as evidence. Use only supplied sentence and source IDs. Omit weak matches.",
          },
          {
            role: "user",
            content: JSON.stringify({
              claims: targets.map((sentence) => ({ id: sentence.id, text: sentenceText(sentence) })),
              sources: sources.map((source) => ({ id: source.id, title: source.title, abstract: source.abstract })),
            }),
          },
        ],
        text: { format: zodTextFormat(CitationMatchesSchema, "citation_matches") },
      });
      const validated = validateCitationMatches(response.output_parsed?.matches ?? [], targets, sources);
      if (validated.length) return validated.slice(0, 2);
    } catch {
      // The deterministic matcher still requires exact abstract evidence.
    }
  }
  return fallbackCitationMatches(targets, sources);
}

function validateCitationMatches(
  matches: z.infer<typeof CitationMatchesSchema>["matches"],
  targets: Sentence[],
  sources: WorkSource[],
): Array<Extract<EditOperation, { type: "add-citation" }>> {
  const targetMap = new Map(targets.map((sentence) => [sentence.id, sentence]));
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const usedSentences = new Set<string>();
  const usedSources = new Set<string>();
  return matches.flatMap((match) => {
    const sentence = targetMap.get(match.sentenceId);
    const source = sourceMap.get(match.sourceId);
    const abstract = source?.abstract;
    const evidence = bestAbstractEvidence(sentence ? sentenceText(sentence) : "", match.evidence.trim());
    const rationale = match.rationale.replace(/\s+/g, " ").trim().slice(0, 320);
    if (
      !sentence || !source || !abstract || !evidence || !rationale ||
      !abstract.includes(evidence) ||
      !citationEvidenceSupportsClaim(sentenceText(sentence), evidence) ||
      usedSentences.has(sentence.id) || usedSources.has(source.id)
    ) return [];
    usedSentences.add(sentence.id);
    usedSources.add(source.id);
    return [{
      type: "add-citation" as const,
      sentenceId: sentence.id,
      source,
      claimText: sentenceText(sentence),
      rationale,
      evidence,
    }];
  });
}

function fallbackCitationMatches(
  targets: Sentence[],
  sources: WorkSource[],
): Array<Extract<EditOperation, { type: "add-citation" }>> {
  const candidates = targets.flatMap((sentence) =>
    sources.flatMap((source) => {
      const evidence = bestAbstractEvidence(sentenceText(sentence), source.abstract);
      const terms = evidence ? sharedContentTerms(sentenceText(sentence), evidence) : [];
      const score = evidence ? citationSupportScore(sentenceText(sentence), evidence) : 0;
      return evidence && citationEvidenceSupportsClaim(sentenceText(sentence), evidence)
        ? [{ sentence, source, evidence, terms, score }]
        : [];
    }),
  ).sort((left, right) => right.score - left.score || right.terms.length - left.terms.length);
  const usedSentences = new Set<string>();
  const usedSources = new Set<string>();
  return candidates.flatMap(({ sentence, source, evidence, terms }) => {
    if (usedSentences.has(sentence.id) || usedSources.has(source.id)) return [];
    usedSentences.add(sentence.id);
    usedSources.add(source.id);
    const concepts = sharedConcepts(sentenceText(sentence), evidence).slice(0, 3).join(", ");
    return [{
      type: "add-citation" as const,
      sentenceId: sentence.id,
      source,
      claimText: sentenceText(sentence),
      rationale: `The quoted abstract evidence covers the claim's core concepts: ${concepts}.`,
      evidence,
    }];
  }).slice(0, 2);
}

function bestAbstractEvidence(claim: string, abstract: string | null): string | undefined {
  if (!abstract) return undefined;
  return abstract
    .split(/(?<=[.!?])\s+/)
    .map((evidence) => ({ evidence: evidence.trim(), score: citationSupportScore(claim, evidence) }))
    .filter(({ evidence }) => evidence.length >= 24)
    .sort((left, right) => right.score - left.score)[0]?.evidence;
}

const CONTENT_STOP_WORDS = new Set([
  "about", "advanced", "after", "also", "approach", "based", "because", "been", "before", "being",
  "between", "both", "built", "could", "during", "each", "from", "have", "into", "model", "models",
  "more", "other", "over", "paper", "results", "same", "such", "system", "systems", "than", "that",
  "their", "these", "they", "this", "through", "using", "were", "which", "while", "with", "work",
  "would",
]);

function citationEvidenceSupportsClaim(claim: string, evidence: string): boolean {
  const shared = sharedContentTerms(claim, evidence);
  const claimTerms = [...new Set(contentTerms(claim))];
  const coverage = shared.length / Math.max(1, Math.min(claimTerms.length, 8));
  return shared.length >= 2 && coverage >= 0.3;
}

function citationSupportScore(claim: string, evidence: string): number {
  const shared = sharedContentTerms(claim, evidence).length;
  const claimTerms = [...new Set(contentTerms(claim))].length;
  return shared + shared / Math.max(1, claimTerms);
}

function sharedConcepts(left: string, right: string): string[] {
  const rightPairs = new Set(contentPairs(right));
  const pairs = contentPairs(left).filter((pair) => rightPairs.has(pair));
  const pairedTerms = new Set(pairs.flatMap((pair) => pair.split(" ")));
  const unpaired = sharedContentTerms(left, right).filter((term) => !pairedTerms.has(term));
  return [...pairs.map((pair) => pair === "open ended" ? "open-ended" : pair), ...unpaired];
}

function contentPairs(value: string): string[] {
  const terms = contentTerms(value);
  return terms.slice(0, -1).map((term, index) => `${term} ${terms[index + 1]}`);
}

function citationDiscoveryQuery(
  paper: Paper,
  section: Section,
  goal: string,
  targets: Sentence[],
): string {
  const perClaimTerms = targets.map((sentence) => contentTerms(sentenceText(sentence)));
  const roundRobinTerms: string[] = [];
  for (let termIndex = 0; termIndex < 5; termIndex += 1) {
    for (const terms of perClaimTerms) {
      const term = terms[termIndex];
      if (term && !roundRobinTerms.includes(term)) roundRobinTerms.push(term);
    }
  }
  return [paper.title, section.title, goal, roundRobinTerms.slice(0, 32).join(" ")]
    .join(". ")
    .slice(0, 700);
}

function sharedContentTerms(left: string, right: string): string[] {
  const rightTerms = new Set(contentTerms(right));
  return [...new Set(contentTerms(left).filter((term) => rightTerms.has(term)))];
}

function contentTerms(value: string): string[] {
  return normalizedTitle(value)
    .split(" ")
    .filter((term) => term.length >= 4 && !CONTENT_STOP_WORDS.has(term));
}

async function proposeSourcedClaim(
  section: Section,
  paper: Paper,
  goal: string,
): Promise<EditOperation[]> {
  if (!hasModelAccess()) {
    throw new AppError(
      "model_required",
      "Adding a new claim requires a configured model; source discovery alone cannot safely author prose.",
      422,
    );
  }
  const discovery = await discoverWorks(`${paper.title}. ${section.title}. ${goal}`.slice(0, 1_800), []);
  const sources = excludeExisting(discovery.sources, paper).filter((source) => source.abstract).slice(0, 5);
  if (!sources.length) throw new AppError("no_sources_found", "No abstract-backed source was found.", 422);
  const response = await getOpenAI().responses.parse({
    model: modelName(),
    input: [
      {
        role: "system",
        content:
          "Write one conservative sentence supported directly by one supplied abstract. Select exactly one supplied source ID. Do not add numbers or comparisons not present in that abstract.",
      },
      {
        role: "user",
        content: JSON.stringify({ goal, sources: sources.map((source) => ({ id: source.id, abstract: source.abstract })) }),
      },
    ],
    text: { format: zodTextFormat(SourcedClaimSchema, "sourced_claim") },
  });
  const claim = response.output_parsed;
  const source = sources.find((candidate) => candidate.id === claim?.sourceId);
  if (!claim || !source || !claim.text.trim()) {
    throw new AppError("unsafe_sourced_claim", "The sourced claim could not be verified.", 422);
  }
  return [{
    type: "add-sourced-sentence",
    sectionId: section.id,
    afterSentenceId: section.paragraphs.at(-1)?.sentences.at(-1)?.id,
    text: claim.text.trim(),
    sources: [source],
  }];
}

function applySentenceRewrite(
  paper: Paper,
  operation: Extract<EditOperation, { type: "replace-sentence" }>,
): void {
  const sentence = findSentence(paper, operation.sentenceId);
  if (!sentence || sentenceText(sentence) !== operation.beforeText) {
    throw new AppError("stale_sentence", "The proposed rewrite no longer matches the paper.", 409);
  }
  const citations = sentence.nodes.filter((node) => node.type === "citation");
  sentence.nodes = [{ type: "text", value: operation.afterText }, ...citations];
}

function applyCitation(
  paper: Paper,
  operation: Extract<EditOperation, { type: "add-citation" }>,
): void {
  const sentence = findSentence(paper, operation.sentenceId);
  if (!sentence) throw new AppError("sentence_not_found", "The citation target no longer exists.", 409);
  const referenceId = operation.source.id;
  if (!paper.references.some((reference) => reference.id === referenceId)) {
    paper.references.push({
      id: referenceId,
      csl: { ...operation.source.csl, id: referenceId },
      status: "resolved",
      confidence: 1,
      providerIds: operation.source.providerIds,
    });
  }
  sentence.nodes.push({
    type: "citation",
    anchorId: `added-${randomUUID()}`,
    referenceIds: [referenceId],
    raw: "",
  });
}

function applySourcedSentence(
  paper: Paper,
  operation: Extract<EditOperation, { type: "add-sourced-sentence" }>,
): void {
  const paragraphs =
    operation.sectionId === "abstract"
      ? paper.abstract
      : paper.sections.find((candidate) => candidate.id === operation.sectionId)?.paragraphs;
  if (!paragraphs) throw new AppError("section_not_found", "The target section no longer exists.", 409);
  for (const source of operation.sources) {
    if (!paper.references.some((reference) => reference.id === source.id)) {
      paper.references.push({
        id: source.id,
        csl: { ...source.csl, id: source.id },
        status: "resolved",
        confidence: 1,
        providerIds: source.providerIds,
      });
    }
  }
  const sentence: Sentence = {
    id: `added-sentence-${randomUUID()}`,
    nodes: [
      { type: "text", value: operation.text },
      ...operation.sources.map((source) => ({
        type: "citation" as const,
        anchorId: `added-${randomUUID()}`,
        referenceIds: [source.id],
        raw: "",
      })),
    ],
  };
  const paragraph = paragraphs.at(-1) ?? {
    id: `added-paragraph-${randomUUID()}`,
    kind: "prose" as const,
    sentences: [],
  };
  if (!paragraphs.length) paragraphs.push(paragraph);
  const afterIndex = operation.afterSentenceId
    ? paragraph.sentences.findIndex((candidate) => candidate.id === operation.afterSentenceId)
    : -1;
  paragraph.sentences.splice(afterIndex >= 0 ? afterIndex + 1 : paragraph.sentences.length, 0, sentence);
}

function resolveSection(sectionId: string, paper: Paper): Section {
  if (sectionId === "abstract") {
    return { id: "abstract", level: 1, title: "Abstract", paragraphs: paper.abstract };
  }
  const section = paper.sections.find((candidate) => candidate.id === sectionId);
  if (!section) throw new AppError("section_not_found", "The requested section was not found.", 422);
  return section;
}

function matchSectionId(command: string, paper: Paper): string {
  if (/abstract/.test(command)) return "abstract";
  const direct = paper.sections.find((section) => command.includes(section.title.toLowerCase()));
  if (direct) return direct.id;
  if (/intro/.test(command)) {
    return paper.sections.find((section) => /intro/i.test(section.title))?.id ?? paper.sections[0]?.id ?? "abstract";
  }
  if (/method/.test(command)) {
    return paper.sections.find((section) => /method/i.test(section.title))?.id ?? paper.sections[0]?.id ?? "abstract";
  }
  return paper.sections[0]?.id ?? "abstract";
}

function findSentence(paper: Paper, sentenceId: string): Sentence | undefined {
  for (const paragraph of paper.abstract) {
    const sentence = paragraph.sentences.find((candidate) => candidate.id === sentenceId);
    if (sentence) return sentence;
  }
  for (const section of paper.sections) {
    for (const paragraph of section.paragraphs) {
      const sentence = paragraph.sentences.find((candidate) => candidate.id === sentenceId);
      if (sentence) return sentence;
    }
  }
  return undefined;
}

function compressText(value: string): string {
  const withoutHedges = value
    .replace(/\b(?:it is important to note that|it should be noted that|in order to|the fact that)\b/gi, "")
    .replace(/\b(?:very|really|quite|generally|essentially|basically)\b/gi, "")
    .replace(/^\s*(?:however|moreover|furthermore|therefore),?\s+/i, "")
    .replace(/\bwe (?:aim to|seek to|attempt to)\b/gi, "we")
    .replace(/\s+/g, " ")
    .trim();
  const clauses = withoutHedges.split(/;|, which |, while /i);
  return clauses.slice(0, Math.min(2, clauses.length)).join(", ").trim();
}

function excludeExisting(sources: WorkSource[], paper: Paper): WorkSource[] {
  const dois = new Set(paper.references.map((reference) => normalizedDoi(reference.csl.DOI)).filter(Boolean));
  const titles = new Set(paper.references.map((reference) => normalizedTitle(reference.csl.title ?? "")).filter(Boolean));
  return sources.filter(
    (source) =>
      !isUploadedPaper(source, paper) &&
      (!source.doi || !dois.has(normalizedDoi(source.doi))) && !titles.has(normalizedTitle(source.title)),
  );
}

function proposalSummary(plan: EditPlan, section: Section, count: number): string {
  if (plan.intent === "SHORTEN_SECTION") return `Shorten ${count} sentence${count === 1 ? "" : "s"} in ${section.title}.`;
  if (plan.intent === "ADD_CITATIONS") return `Attach ${count} verified source${count === 1 ? "" : "s"} to claims in ${section.title}.`;
  return `Add one abstract-grounded claim to ${section.title}.`;
}
