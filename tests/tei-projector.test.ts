import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sentenceCitationIds, sentenceText } from "@/lib/domain";
import { projectTeiToPaper } from "@/lib/tei-projector";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("projectTeiToPaper", () => {
  it("projects linked numeric citations into stable CSL-backed anchors", () => {
    const paper = projectTeiToPaper(fixture("numeric-paper.tei.xml"), "abc123");

    expect(paper.title).toBe("Reliable Evidence Systems");
    expect(paper.authors).toEqual(["Ada Lovelace"]);
    expect(paper.sections[0]?.title).toBe("Introduction");
    expect(paper.references).toHaveLength(1);
    expect(paper.references[0]?.csl.DOI).toBe("10.1000/reliable.2024");
    expect(paper.references[0]?.csl["container-title"]).toBe("Journal of Reliable Systems");
    expect(paper.citationStyle).toMatchObject({ family: "numeric", cslId: "ieee" });

    const sentence = paper.sections[0]?.paragraphs[0]?.sentences[0];
    expect(sentence && sentenceText(sentence)).toBe("Prior systems lose citation context .");
    expect(sentence && sentenceCitationIds(sentence)).toEqual(["b0"]);
    expect(sentence?.nodes[1]).toMatchObject({ type: "citation", anchorId: "c-1", raw: "[1]" });
  });

  it("surfaces an unknown bibliography target instead of dropping it", () => {
    const paper = projectTeiToPaper(fixture("author-date-paper.tei.xml"), "def456");

    expect(paper.citationStyle).toMatchObject({ family: "author-date", cslId: "apa" });
    expect(paper.references[0]).toMatchObject({ id: "missing", status: "unresolved", confidence: 0 });
    expect(paper.warnings.some((warning) => warning.code === "missing_reference_target")).toBe(true);
  });
});
