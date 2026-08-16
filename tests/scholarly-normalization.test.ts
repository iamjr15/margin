import { describe, expect, it } from "vitest";
import type { WorkSource } from "@/lib/domain";
import { reconstructAbstract } from "@/lib/scholarly/openalex";
import {
  createRequestThrottle,
  isUploadedPaper,
  mergeSources,
  normalizedTitle,
} from "@/lib/scholarly/shared";

describe("scholarly normalization", () => {
  it("normalizes title diacritics without splitting a word", () => {
    expect(normalizedTitle("Gödel machine")).toBe(normalizedTitle("Godel machine"));
  });

  it("reconstructs OpenAlex abstracts by token position", () => {
    expect(
      reconstructAbstract({ reliable: [2], systems: [3], Evidence: [0], preserving: [1] }),
    ).toBe("Evidence preserving reliable systems");
  });

  it("deduplicates cross-provider works by DOI and preserves provenance", () => {
    const semantic = source({
      providers: ["semantic-scholar"],
      providerIds: { semanticScholar: "s2-1" },
      abstract: "Short abstract.",
    });
    const openAlex = source({
      providers: ["openalex"],
      providerIds: { openAlex: "W1" },
      abstract: "A longer abstract with more complete evidence.",
    });
    const merged = mergeSources([semantic, openAlex]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.providers).toEqual(["semantic-scholar", "openalex"]);
    expect(merged[0]?.providerIds).toEqual({ semanticScholar: "s2-1", openAlex: "W1" });
    expect(merged[0]?.abstract).toBe("A longer abstract with more complete evidence.");
  });

  it("serializes provider requests below a configured rate limit", async () => {
    const throttle = createRequestThrottle(20);
    const started: number[] = [];

    await Promise.all([1, 2, 3].map(async () => {
      await throttle();
      started.push(Date.now());
    }));

    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(18);
    expect(started[2]! - started[1]!).toBeGreaterThanOrEqual(18);
  });

  it("filters the uploaded paper from related-work recommendations", () => {
    const paper = {
      title: "Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents",
      authors: ["Jigyasa Patel", "Jeff Clune"],
      identifiers: { doi: "10.1000/dgm" },
    };
    expect(isUploadedPaper(source({ title: paper.title, doi: undefined }), paper)).toBe(true);
    expect(isUploadedPaper(source({ title: "Different work", doi: "10.1000/dgm" }), paper)).toBe(true);
    expect(isUploadedPaper(source({ title: "Different work", doi: "10.1000/other" }), paper)).toBe(false);
    expect(isUploadedPaper(source({
      title: "Darwin Gödel Machine",
      authors: ["Jigyasa Patel"],
      doi: undefined,
    }), paper)).toBe(true);
  });

  it("recognizes the uploaded paper across diacritics and provider author ordering", () => {
    expect(isUploadedPaper(source({
      title: "Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents",
      authors: ["Zhang, Jenny", "Hu, Shengran"],
      doi: undefined,
    }), {
      title: "DARWIN GÖDEL MACHINE: OPEN-ENDED EVOLUTION OF SELF-IMPROVING AGENTS",
      authors: ["Jenny Zhang", "Shengran Hu"],
      identifiers: {},
    })).toBe(true);
  });
});

function source(overrides: Partial<WorkSource>): WorkSource {
  return {
    id: "doi:10.1000/test",
    title: "Evidence systems",
    authors: ["Ada Lovelace"],
    year: 2024,
    abstract: null,
    doi: "10.1000/test",
    url: "https://doi.org/10.1000/test",
    providerIds: {},
    providers: ["semantic-scholar"],
    retrievalMethod: "exact-id",
    csl: { id: "doi:10.1000/test", type: "article-journal", title: "Evidence systems" },
    ...overrides,
  };
}
