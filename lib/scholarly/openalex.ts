import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReferenceRecord, WorkSource } from "@/lib/domain";
import { fetchProviderJson, normalizedDoi } from "@/lib/scholarly/shared";

const BASE_URL = "https://api.openalex.org";

const OpenAlexWorkSchema = z.object({
  id: z.string().url(),
  doi: z.string().url().nullable().optional(),
  display_name: z.string(),
  publication_year: z.number().int().nullable().optional(),
  type: z.string().nullable().optional(),
  authorships: z
    .array(z.object({ author: z.object({ display_name: z.string() }) }))
    .default([]),
  primary_location: z
    .object({ source: z.object({ display_name: z.string() }).nullable().optional() })
    .nullable()
    .optional(),
  abstract_inverted_index: z.record(z.string(), z.array(z.number().int())).nullable().optional(),
});

const OpenAlexListSchema = z.object({ results: z.array(OpenAlexWorkSchema).default([]) });

type RetrievalMethod = WorkSource["retrievalMethod"];

export async function resolveWithOpenAlex(reference: ReferenceRecord): Promise<WorkSource | null> {
  const doi = normalizedDoi(reference.csl.DOI);
  if (doi) {
    const results = await listWorks({ filter: `doi:${doi}`, perPage: 1 }, "exact-id");
    if (results[0]) return results[0];
  }
  const openAlexId = reference.providerIds.openAlex;
  if (openAlexId) {
    const payload = await fetchProviderJson<unknown>(
      `oa:work:${openAlexId}`,
      withApiKey(`${BASE_URL}/works/${encodeURIComponent(openAlexId)}`),
    );
    const parsed = OpenAlexWorkSchema.safeParse(payload);
    if (parsed.success) return toSource(parsed.data, "exact-id");
  }
  if (!reference.csl.title) return null;
  const results = await listWorks({ exactSearch: reference.csl.title, perPage: 3 }, "title-search");
  return results[0] ?? null;
}

export async function batchResolveOpenAlex(
  references: ReferenceRecord[],
): Promise<Map<string, WorkSource>> {
  const byDoi = new Map(
    references
      .map((reference) => [normalizedDoi(reference.csl.DOI), reference] as const)
      .filter((entry): entry is readonly [string, ReferenceRecord] => Boolean(entry[0])),
  );
  const dois = [...byDoi.keys()].slice(0, 100);
  if (!dois.length) return new Map();
  const works = await listWorks({ filter: `doi:${dois.join("|")}`, perPage: dois.length }, "exact-id");
  const resolved = new Map<string, WorkSource>();
  for (const source of works) {
    const reference = source.doi ? byDoi.get(normalizedDoi(source.doi) ?? "") : undefined;
    if (reference) resolved.set(reference.id, source);
  }
  return resolved;
}

export async function semanticSearchOpenAlex(query: string, limit = 8): Promise<WorkSource[]> {
  return listWorks(
    { semanticSearch: query.slice(0, 2_000), perPage: Math.min(limit, 20) },
    "semantic-search",
  );
}

async function listWorks(
  options: { filter?: string; exactSearch?: string; semanticSearch?: string; perPage: number },
  method: RetrievalMethod,
): Promise<WorkSource[]> {
  const url = new URL(`${BASE_URL}/works`);
  if (options.filter) url.searchParams.set("filter", options.filter);
  if (options.exactSearch) url.searchParams.set("search.exact", options.exactSearch);
  if (options.semanticSearch) url.searchParams.set("search.semantic", options.semanticSearch);
  url.searchParams.set("per-page", String(options.perPage));
  addApiKey(url);
  const payload = await fetchProviderJson<unknown>(
    `oa:list:${hash(url.search)}`,
    url.toString(),
  );
  const parsed = OpenAlexListSchema.safeParse(payload);
  return parsed.success ? parsed.data.results.map((work) => toSource(work, method)) : [];
}

function toSource(work: z.infer<typeof OpenAlexWorkSchema>, method: RetrievalMethod): WorkSource {
  const doi = normalizedDoi(work.doi ?? undefined);
  const openAlexId = work.id.split("/").at(-1) ?? work.id;
  const id = doi ? `doi:${doi}` : `oa:${openAlexId}`;
  const authors = work.authorships.map((entry) => entry.author.display_name);
  const venue = work.primary_location?.source?.display_name ?? undefined;
  return {
    id,
    title: work.display_name,
    authors,
    year: work.publication_year ?? undefined,
    abstract: reconstructAbstract(work.abstract_inverted_index),
    doi,
    url: doi ? `https://doi.org/${doi}` : work.id,
    providerIds: { openAlex: openAlexId },
    providers: ["openalex"],
    retrievalMethod: method,
    csl: {
      id,
      type: mapType(work.type),
      title: work.display_name,
      author: authors.map(nameToCsl),
      ...(work.publication_year ? { issued: { "date-parts": [[work.publication_year]] } } : {}),
      ...(venue ? { "container-title": venue } : {}),
      ...(doi ? { DOI: doi, URL: `https://doi.org/${doi}` } : { URL: work.id }),
    },
  };
}

export function reconstructAbstract(
  inverted: Record<string, number[]> | null | undefined,
): string | null {
  if (!inverted) return null;
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(inverted)) {
    positions.forEach((position) => words.push([position, word]));
  }
  return words.sort((a, b) => a[0] - b[0]).map((entry) => entry[1]).join(" ") || null;
}

function withApiKey(value: string): string {
  const url = new URL(value);
  addApiKey(url);
  return url.toString();
}

function addApiKey(url: URL): void {
  if (process.env.OPENALEX_API_KEY) url.searchParams.set("api_key", process.env.OPENALEX_API_KEY);
}

function mapType(type: string | null | undefined): string {
  if (type === "book") return "book";
  if (type === "proceedings-article") return "paper-conference";
  return "article-journal";
}

function nameToCsl(name: string): { family?: string; given?: string; literal?: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { literal: name };
  return { family: parts.at(-1), given: parts.slice(0, -1).join(" ") };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}
