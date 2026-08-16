import type { ReferenceRecord, WorkSource } from "@/lib/domain";
import {
  batchResolveOpenAlex,
  resolveWithOpenAlex,
  semanticSearchOpenAlex,
} from "@/lib/scholarly/openalex";
import {
  batchResolveSemanticScholar,
  recommendWithSemanticScholar,
  resolveWithSemanticScholar,
  searchSemanticScholar,
} from "@/lib/scholarly/semantic-scholar";
import { mergeSources, normalizedTitle } from "@/lib/scholarly/shared";

export interface ProviderState {
  semanticScholar: "ok" | "partial" | "unavailable";
  openAlex: "ok" | "partial" | "unavailable";
}

export interface ResolutionResult {
  byReferenceId: Map<string, WorkSource>;
  sources: WorkSource[];
  providerState: ProviderState;
}

export async function resolveReferences(references: ReferenceRecord[]): Promise<ResolutionResult> {
  const [semanticBatch, openAlexBatch] = await Promise.allSettled([
    batchResolveSemanticScholar(references),
    batchResolveOpenAlex(references),
  ]);
  const semanticMap = semanticBatch.status === "fulfilled" ? semanticBatch.value : new Map();
  const openAlexMap = openAlexBatch.status === "fulfilled" ? openAlexBatch.value : new Map();
  const byReferenceId = new Map<string, WorkSource>();

  for (const reference of references) {
    const merged = mergeSources(
      [semanticMap.get(reference.id), openAlexMap.get(reference.id)].filter(
        (source): source is WorkSource => Boolean(source),
      ),
    )[0];
    if (merged) byReferenceId.set(reference.id, merged);
  }

  const unresolved = references.filter((reference) => !byReferenceId.has(reference.id)).slice(0, 4);
  for (const reference of unresolved) {
    const [semantic, openAlex] = await Promise.allSettled([
      resolveWithSemanticScholar(reference),
      resolveWithOpenAlex(reference),
    ]);
    const candidates = mergeSources(
      [
        semantic.status === "fulfilled" ? semantic.value : null,
        openAlex.status === "fulfilled" ? openAlex.value : null,
      ].filter((source): source is WorkSource => Boolean(source)),
    ).filter((source) => likelyMatches(reference, source));
    if (candidates[0]) byReferenceId.set(reference.id, candidates[0]);
  }

  return {
    byReferenceId,
    sources: mergeSources([...byReferenceId.values()]),
    providerState: {
      semanticScholar: semanticBatch.status === "fulfilled" ? "ok" : "partial",
      openAlex: openAlexBatch.status === "fulfilled" ? "ok" : "partial",
    },
  };
}

export async function discoverWorks(
  query: string,
  semanticScholarSeedIds: string[],
): Promise<{ sources: WorkSource[]; providerState: ProviderState }> {
  const [search, recommendations, semantic] = await Promise.allSettled([
    searchSemanticScholar(query, 8),
    recommendWithSemanticScholar(semanticScholarSeedIds),
    semanticSearchOpenAlex(query, 8),
  ]);
  return {
    sources: mergeSources([
      ...(search.status === "fulfilled" ? search.value : []),
      ...(recommendations.status === "fulfilled" ? recommendations.value : []),
      ...(semantic.status === "fulfilled" ? semantic.value : []),
    ]),
    providerState: {
      semanticScholar:
        search.status === "fulfilled" || recommendations.status === "fulfilled" ? "ok" : "unavailable",
      openAlex: semantic.status === "fulfilled" ? "ok" : "unavailable",
    },
  };
}

function likelyMatches(reference: ReferenceRecord, source: WorkSource): boolean {
  if (reference.csl.DOI && source.doi) return true;
  const expected = normalizedTitle(reference.csl.title ?? "");
  const actual = normalizedTitle(source.title);
  if (!expected || !actual) return false;
  const expectedTokens = new Set(expected.split(" "));
  const actualTokens = new Set(actual.split(" "));
  const overlap = [...expectedTokens].filter((token) => actualTokens.has(token)).length;
  const union = new Set([...expectedTokens, ...actualTokens]).size;
  const titleScore = union ? overlap / union : 0;
  const expectedYear = reference.csl.issued?.["date-parts"]?.[0]?.[0];
  const yearMatches = !expectedYear || !source.year || Math.abs(expectedYear - source.year) <= 1;
  return titleScore >= 0.72 && yearMatches;
}
