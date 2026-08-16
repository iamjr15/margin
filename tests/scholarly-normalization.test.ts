import { describe, expect, it } from "vitest";
import type { WorkSource } from "@/lib/domain";
import { reconstructAbstract } from "@/lib/scholarly/openalex";
import { mergeSources } from "@/lib/scholarly/shared";

describe("scholarly normalization", () => {
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
