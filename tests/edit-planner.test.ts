import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/model", () => ({
  getOpenAI: () => ({ responses: { parse: async () => { throw new Error("model unavailable"); } } }),
  hasModelAccess: () => true,
  modelName: () => "test-model",
}));

vi.mock("@/lib/scholarly/academic-search", () => ({
  discoverWorks: async () => ({
    sources: [{
      id: "doi:10.1000/grounded",
      title: "Grounded citation representations",
      authors: ["Grace Hopper"],
      year: 2025,
      abstract: "The representation keeps every anchor explicit while preserving citation context.",
      doi: "10.1000/grounded",
      url: "https://doi.org/10.1000/grounded",
      providerIds: { openAlex: "W-grounded" },
      providers: ["openalex"],
      retrievalMethod: "semantic-search",
      csl: {
        id: "doi:10.1000/grounded",
        type: "article-journal",
        title: "Grounded citation representations",
        DOI: "10.1000/grounded",
        URL: "https://doi.org/10.1000/grounded",
      },
    }],
    providerState: { semanticScholar: "ok", openAlex: "ok" },
  }),
}));

import { proposeEdit } from "@/lib/edit";
import { projectTeiToPaper } from "@/lib/tei-projector";

describe("edit planner provenance", () => {
  it("labels a configured but failed model call as deterministic fallback", async () => {
    const paper = projectTeiToPaper(
      readFileSync(new URL("./fixtures/numeric-paper.tei.xml", import.meta.url), "utf8"),
      "planner-fallback",
    );
    const text = paper.sections[0]?.paragraphs[0]?.sentences[0]?.nodes[0];
    if (text?.type === "text") {
      text.value = "It is important to note that our representation is very carefully designed in order to keep every existing citation anchor explicitly attached to its original sentence and context ";
    }

    const proposal = await proposeEdit("document-1", "version-1", paper, "Make the introduction shorter");

    expect(proposal.engine).toBe("deterministic-fallback");
    expect(proposal.operations.some((operation) => operation.type === "replace-sentence")).toBe(true);
  });

  it("attaches a citation only with a claim-level rationale and exact abstract evidence", async () => {
    const paper = projectTeiToPaper(
      readFileSync(new URL("./fixtures/numeric-paper.tei.xml", import.meta.url), "utf8"),
      "planner-citation-match",
    );

    const proposal = await proposeEdit(
      "document-2",
      "version-2",
      paper,
      "Can we add more citations to the intro?",
    );
    const operation = proposal.operations.find((candidate) => candidate.type === "add-citation");

    expect(operation).toMatchObject({
      type: "add-citation",
      sentenceId: "s-2",
      claimText: "Our representation keeps every anchor explicit.",
      evidence: "The representation keeps every anchor explicit while preserving citation context.",
    });
    expect(operation?.rationale).toContain("claim's core concepts");
    expect(operation?.source.abstract).toContain(operation?.evidence);
  });

  it("fails closed when retrieved abstracts only share a broad topic", async () => {
    const paper = projectTeiToPaper(
      readFileSync(new URL("./fixtures/numeric-paper.tei.xml", import.meta.url), "utf8"),
      "planner-weak-citation",
    );
    for (const sentence of paper.sections[0]?.paragraphs.flatMap((paragraph) => paragraph.sentences) ?? []) {
      if (sentence.nodes.some((node) => node.type === "citation")) continue;
      const text = sentence.nodes.find((node) => node.type === "text");
      if (text?.type === "text") {
        text.value = "Scientific progress remains cumulative and open-ended across many generations of prior insight.";
      }
    }

    await expect(proposeEdit(
      "document-3",
      "version-3",
      paper,
      "Can we add more citations to the intro?",
    )).rejects.toMatchObject({ code: "no_supported_citations" });
  });
});
