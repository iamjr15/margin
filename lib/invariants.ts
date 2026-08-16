import type { EditOperation, Paper, Sentence } from "@/lib/domain";
import { allSentences } from "@/lib/domain";
import { AppError } from "@/lib/errors";

export function assertProposalOperations(operations: EditOperation[]): void {
  for (const operation of operations) {
    if (operation.type === "replace-sentence") {
      if (!operation.afterText.trim()) {
        throw new AppError("empty_rewrite", "A sentence rewrite cannot be empty.", 422);
      }
      continue;
    }
    const sources = operation.type === "add-citation" ? [operation.source] : operation.sources;
    if (operation.type === "add-citation") {
      const explanation = [operation.claimText, operation.rationale, operation.evidence];
      if (explanation.some(Boolean) && explanation.some((value) => !value?.trim())) {
        throw new AppError(
          "incomplete_citation_reasoning",
          "A citation explanation must include the target claim, rationale, and abstract evidence.",
          422,
        );
      }
      if (operation.evidence && !operation.source.abstract?.includes(operation.evidence)) {
        throw new AppError(
          "invalid_citation_evidence",
          "Proposed citation evidence must be an exact excerpt from the source abstract.",
          422,
        );
      }
    }
    for (const source of sources) {
      if (!source.url || Object.keys(source.providerIds).length === 0) {
        throw new AppError(
          "unverified_new_source",
          "A proposed citation was not hydrated from an academic provider.",
          422,
        );
      }
    }
  }
}

export function assertCitationIntegrity(before: Paper, after: Paper): void {
  const beforeAnchors = anchorLocations(before);
  const afterAnchors = anchorLocations(after);
  for (const [anchorId, sentenceIds] of beforeAnchors) {
    if (afterAnchors.get(anchorId)?.join("|") !== sentenceIds.join("|")) {
      throw new AppError(
        "citation_anchor_changed",
        `Existing citation anchor “${anchorId}” was moved or removed.`,
        422,
      );
    }
  }

  const referenceIds = new Set(after.references.map((reference) => reference.id));
  for (const sentence of allSentences(after)) {
    for (const node of sentence.nodes) {
      if (node.type !== "citation") continue;
      for (const referenceId of node.referenceIds) {
        if (!referenceIds.has(referenceId)) {
          throw new AppError(
            "dangling_citation",
            `Citation “${node.anchorId}” points to missing reference “${referenceId}”.`,
            422,
          );
        }
      }
    }
  }
}

function anchorLocations(paper: Paper): Map<string, string[]> {
  const locations = new Map<string, string[]>();
  for (const sentence of allSentences(paper)) {
    recordSentenceAnchors(sentence, locations);
  }
  return locations;
}

function recordSentenceAnchors(sentence: Sentence, locations: Map<string, string[]>): void {
  for (const node of sentence.nodes) {
    if (node.type !== "citation") continue;
    locations.set(node.anchorId, [...(locations.get(node.anchorId) ?? []), sentence.id]);
  }
}
