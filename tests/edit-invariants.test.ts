import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyProposal } from "@/lib/edit";
import { allSentences, sentenceCitationIds, sentenceText, type WorkSource } from "@/lib/domain";
import { assertCitationIntegrity } from "@/lib/invariants";
import { projectTeiToPaper } from "@/lib/tei-projector";

const paper = () =>
  projectTeiToPaper(
    readFileSync(new URL("./fixtures/numeric-paper.tei.xml", import.meta.url), "utf8"),
    "abc123",
  );

describe("citation-safe edits", () => {
  it("rewrites text while preserving the original citation anchor", () => {
    const original = paper();
    const sentence = original.sections[0]?.paragraphs[0]?.sentences[0];
    expect(sentence).toBeDefined();
    const revised = applyProposal(original, [
      {
        type: "replace-sentence",
        sentenceId: sentence?.id ?? "",
        beforeText: sentence ? sentenceText(sentence) : "",
        afterText: "Prior systems can lose citation context.",
      },
    ]);

    const revisedSentence = allSentences(revised).find((candidate) => candidate.id === sentence?.id);
    expect(revisedSentence && sentenceText(revisedSentence)).toBe(
      "Prior systems can lose citation context.",
    );
    expect(revisedSentence && sentenceCitationIds(revisedSentence)).toEqual(["b0"]);
    expect(revisedSentence?.nodes.some((node) => node.type === "citation" && node.anchorId === "c-1")).toBe(true);
  });

  it("adds only provider-hydrated references", () => {
    const original = paper();
    const sentence = original.sections[0]?.paragraphs[0]?.sentences[1];
    const revised = applyProposal(original, [
      { type: "add-citation", sentenceId: sentence?.id ?? "", source: verifiedSource() },
    ]);

    expect(revised.references.some((reference) => reference.id === "doi:10.1000/new")).toBe(true);
    const revisedSentence = allSentences(revised).find((candidate) => candidate.id === sentence?.id);
    expect(revisedSentence && sentenceCitationIds(revisedSentence)).toContain("doi:10.1000/new");
  });

  it("rejects silent removal of an existing anchor", () => {
    const original = paper();
    const broken = structuredClone(original);
    const sentence = broken.sections[0]?.paragraphs[0]?.sentences[0];
    if (sentence) sentence.nodes = sentence.nodes.filter((node) => node.type !== "citation");

    expect(() => assertCitationIntegrity(original, broken)).toThrow(/was moved or removed/);
  });

  it("rejects moving an existing anchor to a different sentence", () => {
    const original = paper();
    const broken = structuredClone(original);
    const [source, target] = broken.sections[0]?.paragraphs[0]?.sentences ?? [];
    const citation = source?.nodes.find((node) => node.type === "citation");
    if (source && target && citation) {
      source.nodes = source.nodes.filter((node) => node !== citation);
      target.nodes.push(citation);
    }

    expect(() => assertCitationIntegrity(original, broken)).toThrow(/was moved or removed/);
  });
});

function verifiedSource(): WorkSource {
  return {
    id: "doi:10.1000/new",
    title: "A verified source",
    authors: ["Grace Hopper"],
    year: 2025,
    abstract: "This source describes a verified evidence system.",
    doi: "10.1000/new",
    url: "https://doi.org/10.1000/new",
    providerIds: { openAlex: "W2" },
    providers: ["openalex"],
    retrievalMethod: "semantic-search",
    csl: {
      id: "doi:10.1000/new",
      type: "article-journal",
      title: "A verified source",
      DOI: "10.1000/new",
      URL: "https://doi.org/10.1000/new",
    },
  };
}
