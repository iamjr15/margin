import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReferenceRecord, WorkSource } from "@/lib/domain";
import { createRequestThrottle, fetchProviderJson, normalizedDoi } from "@/lib/scholarly/shared";

const BASE_URL = "https://api.semanticscholar.org/graph/v1";
const RECOMMENDATIONS_URL = "https://api.semanticscholar.org/recommendations/v1";
const FIELDS = "paperId,title,abstract,authors,year,venue,url,externalIds";
const beforeSemanticScholarRequest = createRequestThrottle(1_100);

const S2PaperSchema = z.object({
  paperId: z.string(),
  title: z.string(),
  abstract: z.string().nullable().optional(),
  year: z.number().int().nullable().optional(),
  venue: z.string().nullable().optional(),
  url: z.string().url().nullable().optional(),
  authors: z.array(z.object({ name: z.string() })).default([]),
  externalIds: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).nullable().optional(),
});

const S2SearchSchema = z.object({ data: z.array(S2PaperSchema).default([]) });
const S2RecommendationsSchema = z.object({ recommendedPapers: z.array(S2PaperSchema).default([]) });
const S2BatchSchema = z.array(S2PaperSchema.nullable());

type RetrievalMethod = WorkSource["retrievalMethod"];

export async function resolveWithSemanticScholar(
  reference: ReferenceRecord,
): Promise<WorkSource | null> {
  const doi = normalizedDoi(reference.csl.DOI);
  if (doi) {
    const paper = await fetchS2Paper(`DOI:${doi}`);
    if (paper) return toSource(paper, "exact-id");
  }
  const s2Id = reference.providerIds.semanticScholar;
  if (s2Id) {
    const paper = await fetchS2Paper(s2Id);
    if (paper) return toSource(paper, "exact-id");
  }
  if (!reference.csl.title) return null;
  const results = await searchSemanticScholar(reference.csl.title, 3);
  return results[0] ?? null;
}

export async function batchResolveSemanticScholar(
  references: ReferenceRecord[],
): Promise<Map<string, WorkSource>> {
  const resolvable = references
    .map((reference) => ({ reference, doi: normalizedDoi(reference.csl.DOI) }))
    .filter((item): item is { reference: ReferenceRecord; doi: string } => Boolean(item.doi))
    .slice(0, 500);
  if (!resolvable.length) return new Map();
  const ids = resolvable.map((item) => `DOI:${item.doi}`);
  const payload = await fetchProviderJson<unknown>(
    `s2:batch:${hash(ids.join("|"))}`,
    `${BASE_URL}/paper/batch?fields=${encodeURIComponent(FIELDS)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...semanticScholarHeaders() },
      body: JSON.stringify({ ids }),
    },
    beforeSemanticScholarRequest,
  );
  const parsed = S2BatchSchema.safeParse(payload);
  const resolved = new Map<string, WorkSource>();
  if (!parsed.success) return resolved;
  parsed.data.forEach((paper, index) => {
    const reference = resolvable[index]?.reference;
    if (paper && reference) resolved.set(reference.id, toSource(paper, "exact-id"));
  });
  return resolved;
}

export async function searchSemanticScholar(query: string, limit = 8): Promise<WorkSource[]> {
  const url = new URL(`${BASE_URL}/paper/search`);
  url.searchParams.set("query", query.slice(0, 500));
  url.searchParams.set("limit", String(Math.min(limit, 20)));
  url.searchParams.set("fields", FIELDS);
  const payload = await fetchProviderJson<unknown>(
    `s2:search:${hash(query)}:${limit}`,
    url.toString(),
    { headers: semanticScholarHeaders() },
    beforeSemanticScholarRequest,
  );
  const parsed = S2SearchSchema.safeParse(payload);
  return parsed.success ? parsed.data.data.map((paper) => toSource(paper, "title-search")) : [];
}

export async function recommendWithSemanticScholar(seedIds: string[]): Promise<WorkSource[]> {
  if (!seedIds.length) return [];
  const ids = [...new Set(seedIds)].slice(0, 5);
  const payload = await fetchProviderJson<unknown>(
    `s2:recommend:${hash(ids.join("|"))}`,
    `${RECOMMENDATIONS_URL}/papers/?limit=10&fields=${encodeURIComponent(FIELDS)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...semanticScholarHeaders() },
      body: JSON.stringify({ positivePaperIds: ids, negativePaperIds: [] }),
    },
    beforeSemanticScholarRequest,
  );
  const parsed = S2RecommendationsSchema.safeParse(payload);
  return parsed.success
    ? parsed.data.recommendedPapers.map((paper) => toSource(paper, "seed-recommendation"))
    : [];
}

async function fetchS2Paper(identifier: string) {
  const payload = await fetchProviderJson<unknown>(
    `s2:paper:${identifier.toLowerCase()}`,
    `${BASE_URL}/paper/${encodeURIComponent(identifier)}?fields=${encodeURIComponent(FIELDS)}`,
    { headers: semanticScholarHeaders() },
    beforeSemanticScholarRequest,
  );
  const parsed = S2PaperSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function toSource(paper: z.infer<typeof S2PaperSchema>, method: RetrievalMethod): WorkSource {
  const doi = normalizedDoi(asString(paper.externalIds?.DOI));
  const paperId = paper.paperId;
  const id = doi ? `doi:${doi}` : `s2:${paperId}`;
  const authors = paper.authors.map((author) => author.name);
  return {
    id,
    title: paper.title,
    authors,
    year: paper.year ?? undefined,
    abstract: paper.abstract ?? null,
    doi,
    url: doi ? `https://doi.org/${doi}` : paper.url || `https://www.semanticscholar.org/paper/${paperId}`,
    providerIds: { semanticScholar: paperId },
    providers: ["semantic-scholar"],
    retrievalMethod: method,
    csl: {
      id,
      type: "article-journal",
      title: paper.title,
      author: authors.map(nameToCsl),
      ...(paper.year ? { issued: { "date-parts": [[paper.year]] } } : {}),
      ...(paper.venue ? { "container-title": paper.venue } : {}),
      ...(doi ? { DOI: doi, URL: `https://doi.org/${doi}` } : { URL: paper.url ?? undefined }),
    },
  };
}

function semanticScholarHeaders(): Record<string, string> {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  return key ? { "x-api-key": key } : {};
}

function nameToCsl(name: string): { family?: string; given?: string; literal?: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { literal: name };
  return { family: parts.at(-1), given: parts.slice(0, -1).join(" ") };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function asString(value: string | number | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
