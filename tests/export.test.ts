import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serializePaperToPandoc } from "@/lib/export";
import { projectTeiToPaper } from "@/lib/tei-projector";

describe("Pandoc export", () => {
  it("renders stable citation IDs and keeps unresolved references visible", () => {
    const paper = projectTeiToPaper(
      readFileSync(new URL("./fixtures/numeric-paper.tei.xml", import.meta.url), "utf8"),
      "abc123",
    );
    const markdown = serializePaperToPandoc(paper);

    expect(markdown).toContain('title: "Reliable Evidence Systems"');
    expect(markdown).toContain("## Introduction");
    expect(markdown).toContain("[@b0]");
    expect(markdown).toContain("nocite:");
  });

  it("normalizes common Unicode math symbols for portable TeX output", () => {
    const paper = projectTeiToPaper(
      readFileSync(new URL("./fixtures/numeric-paper.tei.xml", import.meta.url), "utf8"),
      "abc123",
    );
    const text = paper.sections[0]?.paragraphs[0]?.sentences[1]?.nodes[0];
    if (text?.type === "text") text.value = "For φ ∈ Ξ, the bound is ≥ π.";

    const markdown = serializePaperToPandoc(paper);
    expect(markdown).toContain("$\\varphi$ $\\in$ $\\Xi$");
    expect(markdown).toContain("$\\geq$ $\\pi$");
  });

  it("escapes literal at-signs while keeping only structured citation nodes active", () => {
    const paper = projectTeiToPaper(
      readFileSync(new URL("./fixtures/numeric-paper.tei.xml", import.meta.url), "utf8"),
      "abc123",
    );
    const sentence = paper.sections[0]!.paragraphs[0]!.sentences[1]!;
    sentence.nodes = [
      { type: "text", value: "Use @pytest.fixture with " },
      { type: "citation", anchorId: "unlinked-code-like", referenceIds: [], raw: "[start, end]" },
    ];

    const markdown = serializePaperToPandoc(paper);
    expect(markdown).toContain("\\@pytest.fixture");
    expect(markdown).toContain("\\[start, end\\]");
    expect(markdown).not.toContain("@pytest.fixture not found");
  });

  it("serializes extracted code as fenced code instead of manuscript headings", () => {
    const paper = projectTeiToPaper(
      readFileSync(new URL("./fixtures/numeric-paper.tei.xml", import.meta.url), "utf8"),
      "abc123",
    );
    const paragraph = paper.sections[0]!.paragraphs[0]!;
    paragraph.kind = "code";
    paragraph.sentences[0]!.nodes = [{ type: "text", value: "@pytest.fixture\nreturn value" }];

    const markdown = serializePaperToPandoc(paper);
    expect(markdown).toContain("~~~\n@pytest.fixture\nreturn value");
    expect(markdown).not.toContain("\\@pytest.fixture");
  });
});
