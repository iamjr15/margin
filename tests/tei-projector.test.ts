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
    expect(sentence && sentenceText(sentence)).toBe("Prior systems lose citation context.");
    expect(sentence && sentenceCitationIds(sentence)).toEqual(["b0"]);
    expect(sentence?.nodes[1]).toMatchObject({ type: "citation", anchorId: "c-1", raw: "[1]" });
  });

  it("preserves an unlinked callout without inventing a bibliography record", () => {
    const paper = projectTeiToPaper(fixture("author-date-paper.tei.xml"), "def456");

    expect(paper.citationStyle).toMatchObject({ family: "author-date", cslId: "apa" });
    expect(paper.references).toEqual([]);
    expect(paper.sections[0]?.paragraphs[0]?.sentences[0]?.nodes[1]).toMatchObject({
      type: "citation",
      raw: "(Rivera, 2023)",
      referenceIds: [],
    });
    expect(paper.warnings).toContainEqual(
      expect.objectContaining({ code: "unlinked_citations" }),
    );
  });

  it("keeps title metadata scoped and recovers parser-created code headings", () => {
    const paper = projectTeiToPaper(EDGE_CASE_TEI, "edge123");

    expect(paper.title).toBe("Darwin Gödel Machine");
    expect(paper.title).not.toContain("Vector Institute");
    expect(paper.sections.map((section) => section.title)).toEqual(["INTRODUCTION", "E.4 RESULTS"]);
    expect(paper.sections[0]?.paragraphs.some((paragraph) => paragraph.kind === "code")).toBe(true);
    expect(JSON.stringify(paper.sections)).not.toContain("↩");
    expect(paper.references).toHaveLength(1);
    expect(paper.references[0]).toMatchObject({
      id: "b0",
      status: "parsed",
      csl: { title: "Claude 3.5 Sonnet" },
    });
    expect(sentenceCitationIds(paper.sections[0]!.paragraphs[0]!.sentences[0]!)).toEqual(["b0"]);
    expect(
      paper.sections.flatMap((section) => section.paragraphs).flatMap((paragraph) => paragraph.sentences)
        .flatMap((sentence) => sentence.nodes).filter((node) => node.type === "citation"),
    ).toHaveLength(1);
    expect(paper.provenance.recoveredPseudoHeadings).toBe(2);
    expect(paper.warnings).toEqual([]);
  });

  it("splits bibliography rows that GROBID merged and relinks their callouts", () => {
    const paper = projectTeiToPaper(MERGED_REFERENCE_TEI, "merged123");

    expect(paper.references.map((reference) => reference.id)).toEqual(["b0", "b0-split-2", "b1"]);
    expect(paper.references[1]).toMatchObject({
      csl: {
        title: "Self-referential meta learning",
        author: [
          { family: "Kirsch", given: "Louis" },
          { family: "Schmidhuber", given: "Jürgen" },
        ],
        issued: { "date-parts": [[2022]] },
      },
      status: "parsed",
    });
    expect(sentenceCitationIds(paper.sections[0]!.paragraphs[0]!.sentences[0]!)).toEqual([
      "b0-split-2",
      "b1",
    ]);
  });

  it("normalizes TeX accents and removes author spillover from structured titles", () => {
    const paper = projectTeiToPaper(POLLUTED_REFERENCE_TEI, "clean123");

    expect(paper.references[0]?.csl.title).toBe(
      "Eureka: Human-level reward design via coding large language models",
    );
    expect(paper.references[0]?.csl.author?.map((author) => author.family)).toEqual([
      "Ma",
      "Fan",
      "Anandkumar",
    ]);
    expect(paper.references[1]?.csl.title).toBe("Gödel Agent");
    expect(paper.references[1]?.csl.author).toEqual([
      { family: "Schmidhuber", given: "Jürgen" },
    ]);
  });

  it("splits a GROBID-combined appendix parent and subsection heading", () => {
    const paper = projectTeiToPaper(COMBINED_APPENDIX_TEI, "appendix123");

    expect(paper.sections.map(({ id, parentId, level, title }) => ({ id, parentId, level, title }))).toEqual([
      { id: "appendix-parent", parentId: undefined, level: 1, title: "F BEST-DISCOVERED AGENTS" },
      { id: "appendix", parentId: "appendix-parent", level: 2, title: "F.1 DGM ON SWE-BENCH" },
    ]);
    expect(sentenceText(paper.sections[1]!.paragraphs[0]!.sentences[0]!)).toBe("diff --git a/agent.py b/agent.py");
  });

  it("recovers split numeric clusters and demotes spurious bibr fragments to text", () => {
    const paper = projectTeiToPaper(SPURIOUS_BIBR_TEI, "bibr123");
    const nodes = paper.sections[0]!.paragraphs[0]!.sentences[0]!.nodes;

    expect(nodes.filter((node) => node.type === "citation")).toEqual([
      expect.objectContaining({ raw: "[1,", referenceIds: ["b0"] }),
      expect.objectContaining({ raw: "2]", referenceIds: ["b1"] }),
    ]);
    expect(nodes.filter((node) => node.type === "text").map((node) => node.value).join(""))
      .toContain("Robbert van Renesse used dimensions 16 32 64");
    expect(paper.citationStyle).toMatchObject({ family: "numeric", confidence: 1 });
    expect(paper.references[2]).toMatchObject({
      status: "parsed",
      csl: { URL: "https://example.org/2024/paper.pdf" },
    });
    expect(paper.references[2]?.csl.author).toBeUndefined();
    expect(paper.references).toHaveLength(3);
    expect(paper.warnings).toEqual([]);
  });

  it("uses TEI numbering and demotes repeated or layout-created headings generically", () => {
    const paper = projectTeiToPaper(STRUCTURAL_RECOVERY_TEI, "structure123");

    expect(paper.sections.map(({ title, level }) => ({ title, level }))).toEqual([
      { title: "Main section", level: 1 },
      { title: "Second section", level: 1 },
      { title: "Real subsection", level: 2 },
      { title: "Run-in detail:", level: 3 },
      { title: "C. Lettered subsection", level: 2 },
      { title: "IX. ACKNOWLEDGMENTS", level: 1 },
      { title: "APPENDIX A DETAILS", level: 1 },
    ]);
    expect(JSON.stringify(paper.sections)).not.toMatch(/Running Header|\(middle\)|"title":"urations\."/);
    expect(JSON.stringify(paper.sections)).not.toContain('"title":"Daniel"');
    expect(JSON.stringify(paper.sections[0])).toContain("configurations.Figure caption");
    expect(JSON.stringify(paper.sections[2])).toContain("first continuation");
    expect(JSON.stringify(paper.sections[2])).toContain("layout prose");
  });

  it("recovers Roman major headings embedded in paragraph sentences", () => {
    const paper = projectTeiToPaper(INLINE_MAJOR_HEADING_TEI, "inline123");

    expect(paper.sections.map(({ title, level, parentId }) => ({ title, level, parentId }))).toEqual([
      { title: "IV. EXISTING MAJOR", level: 1, parentId: undefined },
      { title: "V. NEXT MAJOR", level: 1, parentId: undefined },
      { title: "A. Child", level: 2, parentId: "section-1-inline-v-next-major" },
      { title: "VI. VARIATIONS", level: 1, parentId: undefined },
      { title: "VII. MITIGATION OPTIONS", level: 1, parentId: undefined },
      { title: "A. Guard", level: 2, parentId: "section-3-inline-vii-mitigation-options" },
      { title: "VIII. CONCLUSIONS", level: 1, parentId: undefined },
    ]);
    expect(JSON.stringify(paper.sections[1])).toContain("New major body.");
    expect(JSON.stringify(paper.sections[4])).toContain("Several countermeasures apply.");
    expect(JSON.stringify(paper.sections[6])).toContain("A final observation remains.");
    expect(JSON.stringify(paper.sections)).not.toContain('"value":"V. NEXT MAJOR"');
  });
});

const EDGE_CASE_TEI = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><fileDesc><titleStmt><title type="main">Darwin Gödel Machine</title><funder>Vector Institute</funder></titleStmt><sourceDesc/></fileDesc></teiHeader>
  <text><body>
    <div xml:id="intro"><head>INTRODUCTION</head><p><s>Prior work matters <ref type="bibr" target="#missing">(Anthropic, 2024a)</ref>.</s></p></div>
    <div><head>↩→ ↩→</head><p><s>-** Additional Details ** :</s></p></div>
    <div><head># Coding Agent Implementation ----- {code} -----</head><p><s>Use @pytest.fixture and <ref type="bibr">[start, end]</ref> safely. ↩→</s></p></div>
    <div><head>E.4 RESULTS</head><p><s>The recovered outline continues.</s></p></div>
  </body><back><div><listBibl><biblStruct xml:id="b0"><monogr><author><persName><surname>Anthropic</surname></persName></author><imprint/></monogr><note type="raw_reference">Anthropic. Claude 3.5 Sonnet. https://example.org, June 2024a.</note></biblStruct></listBibl></div></back></text>
</TEI>`;

const MERGED_REFERENCE_TEI = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><fileDesc><titleStmt><title>Merged bibliography recovery</title></titleStmt><sourceDesc/></fileDesc></teiHeader>
  <text><body><div><head>INTRODUCTION</head><p><s>Meta-learning can be self-referential <ref type="bibr" target="#missing">(Kirsch &amp; Schmidhuber, 2022)</ref>, with safety implications <ref type="bibr">(Yudkowsky et al., 2008)</ref>.</s></p></div></body>
  <back><div><listBibl><biblStruct xml:id="b0"><monogr><title level="m">The neutral theory of molecular evolution</title><author><persName><forename>Motoo</forename><surname>Kimura</surname></persName></author><imprint><date when="1979"/></imprint></monogr><note type="raw_reference">Motoo Kimura. The neutral theory of molecular evolution. Scientific American, 1979. Louis Kirsch and Jürgen Schmidhuber. Self-referential meta learning. In First Conference on Automated Machine Learning, 2022.</note></biblStruct><biblStruct xml:id="b1"><monogr><title level="m">Artificial Intelligence as a positive and negative factor in global risk</title><author><persName><forename>Eliezer</forename><surname>Yudkowsky</surname></persName></author><imprint><date when="2008"/></imprint></monogr><note type="raw_reference">Eliezer Yudkowsky et al. Artificial Intelligence as a positive and negative factor in global risk. Global catastrophic risks, 2008.</note></biblStruct></listBibl></div></back>
  </text>
</TEI>`;

const POLLUTED_REFERENCE_TEI = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><fileDesc><titleStmt><title>Reference cleanup</title></titleStmt><sourceDesc/></fileDesc></teiHeader>
  <text><body><div><head>INTRODUCTION</head><p>Text.</p></div></body><back><div><listBibl>
    <biblStruct xml:id="b0"><analytic><title level="a">Linxi Fan, and Anima Anandkumar. Eureka: Human-level reward design via coding large language models</title><author><persName><forename>Yecheng Jason</forename><surname>Ma</surname></persName></author></analytic><monogr><imprint><date when="2023"/></imprint></monogr><note type="raw_reference">Yecheng Jason Ma, Linxi Fan, and Anima Anandkumar. Eureka: Human-level reward design via coding large language models. arXiv preprint, 2023.</note></biblStruct>
    <biblStruct xml:id="b1"><monogr><title level="m">G\\&quot; odel Agent</title><author><persName><forename>Jürgen</forename><surname>Jürgen Schmidhuber</surname></persName></author><imprint><date when="2025"/></imprint></monogr><note type="raw_reference">Jürgen Schmidhuber. Gödel Agent. Technical report, 2025.</note></biblStruct>
  </listBibl></div></back></text>
</TEI>`;

const COMBINED_APPENDIX_TEI = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><fileDesc><titleStmt><title>Combined appendix</title></titleStmt><sourceDesc/></fileDesc></teiHeader>
  <text><body><div xml:id="appendix"><head>F BEST-DISCOVERED AGENTS F.1 DGM ON SWE-BENCH</head><p>diff --git a/agent.py b/agent.py</p></div></body></text>
</TEI>`;

const SPURIOUS_BIBR_TEI = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><fileDesc><titleStmt><title>Spurious bibliography tags</title></titleStmt><sourceDesc/></fileDesc></teiHeader>
  <text><body><div><head>RESULTS</head><p><s>Prior work <ref type="bibr">[1,</ref><ref type="bibr" target="#b1">2]</ref>; Robbert <ref type="bibr">van</ref> Renesse used dimensions 16 <ref type="bibr">32 64</ref>.</s></p></div></body>
  <back><div><listBibl>
    <biblStruct xml:id="b0"><monogr><title level="m">First source</title><imprint><date when="2020"/></imprint></monogr></biblStruct>
    <biblStruct xml:id="b1"><monogr><title level="m">Second source</title><imprint><date when="2021"/></imprint></monogr></biblStruct>
    <biblStruct xml:id="b2"><monogr><author><persName><surname>Available</surname></persName></author><imprint><date when="2024"/></imprint></monogr><note type="raw_reference">Available: https://example.org/2024/ paper.pdf</note></biblStruct>
    <biblStruct xml:id="b3"><monogr><title level="m">#include &lt;stdint</title><imprint/></monogr><note type="raw_reference">#include &lt;stdint.h&gt;</note></biblStruct>
    <biblStruct xml:id="b4"><monogr><title level="m">14 unsigned int value</title><imprint/></monogr><note type="raw_reference">* / 14 unsigned int value = 16;</note></biblStruct>
  </listBibl></div></back></text>
</TEI>`;

const STRUCTURAL_RECOVERY_TEI = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><fileDesc><titleStmt><title>Structural recovery</title></titleStmt><sourceDesc/></fileDesc></teiHeader>
  <text><body>
    <div><head n="1">Main section</head><p>The old and new config-Figure caption</p></div>
    <div><head>urations.</head><p>Both configurations remain active.</p></div>
    <div><head n="2">Second section</head><p>Second body.</p></div>
    <div><head n="2.1">Real subsection</head><p>Subsection body.</p></div>
    <div><head>Running Header</head><p>first continuation</p></div>
    <div><head>Running Header</head><p>second continuation</p></div>
    <div><head>(middle).</head><p>layout prose</p></div>
    <div><head>Run-in detail:</head><p>Run-in body.</p></div>
    <div><head>C. Lettered subsection</head><p>Lettered body.</p></div>
  </body><back>
    <div type="acknowledgement"><div><p><s>IX. ACKNOWLEDGMENTS Thanks to the reviewers.</s></p></div><div><head>Daniel</head><p>Daniel was supported by a grant.</p></div></div>
    <div type="references"><listBibl><biblStruct xml:id="b0"><monogr><title level="m">Source</title><imprint><date when="2020"/></imprint></monogr></biblStruct></listBibl></div>
    <div type="annex"><div><head>APPENDIX A DETAILS</head><p>Appendix body.</p></div></div>
  </back></text>
</TEI>`;

const INLINE_MAJOR_HEADING_TEI = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><fileDesc><titleStmt><title>Inline headings</title></titleStmt><sourceDesc/></fileDesc></teiHeader>
  <text><body>
    <div><head>IV. EXISTING MAJOR</head><p><s>Existing body.</s><s>V. NEXT MAJOR</s><s>New major body.</s></p></div>
    <div><head>A. Child</head><p>Child body.</p></div>
    <div><head>VI. VARIATIONS</head><p><s>Code tail VII.</s><s>MITIGATION OPTIONS Several countermeasures apply.</s></p></div>
    <div><head>A. Guard</head><p>Guard body.</p></div>
    <div><head>Back matter</head><p><s>VIII. CONCLUSIONS A final observation remains.</s></p></div>
  </body><back><div type="references"><listBibl><biblStruct xml:id="b0"><monogr><title level="m">Source</title><imprint><date when="2020"/></imprint></monogr></biblStruct></listBibl></div></back></text>
</TEI>`;
