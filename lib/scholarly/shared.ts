import type { WorkSource } from "@/lib/domain";
import { getCachedJson, setCachedJson } from "@/lib/repository";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export async function fetchProviderJson<T>(
  cacheKey: string,
  url: string,
  init?: RequestInit,
): Promise<T | null> {
  const cached = getCachedJson<T>(cacheKey);
  if (cached) return cached;
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { Accept: "application/json", ...init?.headers },
        signal: AbortSignal.timeout(20_000),
      });
      lastResponse = response;
      if (response.status === 404) return null;
      if (response.ok) {
        const value = (await response.json()) as T;
        setCachedJson(cacheKey, value, CACHE_TTL_MS);
        return value;
      }
      if (response.status !== 429 && response.status < 500) return null;
      await wait(retryDelay(response, attempt));
    } catch {
      if (attempt < 2) await wait(400 * 2 ** attempt);
    }
  }
  if (lastResponse && lastResponse.status >= 400 && lastResponse.status < 500) return null;
  throw new Error(`Provider request failed: ${new URL(url).hostname}`);
}

export function mergeSources(sources: WorkSource[]): WorkSource[] {
  const merged = new Map<string, WorkSource>();
  for (const source of sources) {
    const key = workKey(source);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, source);
      continue;
    }
    const preferred = source.abstract && (!current.abstract || source.abstract.length > current.abstract.length)
      ? source
      : current;
    merged.set(key, {
      ...preferred,
      id: current.id,
      providerIds: { ...current.providerIds, ...source.providerIds },
      providers: [...new Set([...current.providers, ...source.providers])],
      csl: { ...current.csl, ...source.csl, id: current.id },
    });
  }
  return [...merged.values()];
}

export function normalizedDoi(value: string | undefined): string | undefined {
  const doi = value?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim().toLowerCase();
  return doi || undefined;
}

export function normalizedTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function workKey(source: WorkSource): string {
  return source.doi
    ? `doi:${normalizedDoi(source.doi)}`
    : `${normalizedTitle(source.title)}:${source.year ?? ""}`;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1_000, 5_000);
  return 500 * 2 ** attempt + Math.floor(Math.random() * 150);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
