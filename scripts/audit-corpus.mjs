import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const corpusDirectory = path.resolve(
  process.argv[2] ?? process.env.CORPUS_DIR ?? "../answerthis-paper-corpus",
);
const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const filenames = (await readdir(corpusDirectory))
  .filter((filename) => filename.toLowerCase().endsWith(".pdf"))
  .sort();

if (!filenames.length) throw new Error(`No PDFs found in ${corpusDirectory}`);

const results = [];
for (const filename of filenames) {
  const bytes = await readFile(path.join(corpusDirectory, filename));
  const form = new FormData();
  form.append("paper", new Blob([bytes], { type: "application/pdf" }), filename);
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/documents`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json();
  const snapshot = payload.snapshot ?? payload;
  results.push(auditSnapshot(filename, snapshot, response.status, performance.now() - startedAt));
}

console.log("paper\tHTTP\tstatus\tsections\treferences\tanchors\tunresolved refs\twarnings\tseconds");
for (const result of results) {
  console.log([
    result.filename,
    result.httpStatus,
    result.status,
    result.sections,
    result.references,
    result.anchors,
    result.unresolvedReferences,
    result.warnings,
    result.seconds,
  ].join("\t"));
  for (const issue of result.issues) console.log(`  FAIL: ${issue}`);
}

const failures = results.flatMap((result) => result.issues.map((issue) => `${result.filename}: ${issue}`));
if (failures.length) {
  console.error(`\nCorpus audit failed with ${failures.length} invariant violation(s).`);
  process.exitCode = 1;
} else {
  console.log(`\nCorpus audit passed: ${results.length}/${results.length} papers satisfy every strict invariant.`);
}

function auditSnapshot(filename, snapshot, httpStatus, elapsedMs) {
  const paper = snapshot?.paper;
  const issues = [];
  if (httpStatus !== 201) issues.push(`ingestion returned HTTP ${httpStatus}`);
  if (snapshot?.status !== "READY") issues.push(`document status is ${snapshot?.status ?? "missing"}`);
  if (!paper) {
    issues.push("canonical paper is missing");
    return emptyResult(filename, snapshot, httpStatus, elapsedMs, issues);
  }

  const sections = paper.sections ?? [];
  const paragraphs = [...(paper.abstract ?? []), ...sections.flatMap((section) => section.paragraphs ?? [])];
  const sentences = paragraphs.flatMap((paragraph) => paragraph.sentences ?? []);
  const citations = sentences.flatMap((sentence) =>
    (sentence.nodes ?? []).filter((node) => node.type === "citation"),
  );
  const references = paper.references ?? [];
  const referenceIds = new Set(references.map((reference) => reference.id));
  const codeSentenceIds = new Set(
    paragraphs.filter((paragraph) => paragraph.kind === "code")
      .flatMap((paragraph) => paragraph.sentences.map((sentence) => sentence.id)),
  );
  const citationSentence = new Map();
  for (const sentence of sentences) {
    for (const node of sentence.nodes) {
      if (node.type === "citation") citationSentence.set(node.anchorId, sentence.id);
    }
  }

  if (!paper.title?.trim()) issues.push("title is empty");
  if (!sections.length) issues.push("no body sections were projected");
  if (sections.length && !sections.some((section) => section.level === 1)) {
    issues.push("outline has no level-1 section");
  }
  if (!references.length) issues.push("no bibliography records were projected");
  if (!citations.length) issues.push("no in-text citation anchors were projected");
  if ((paper.warnings ?? []).length) {
    issues.push(`warnings: ${paper.warnings.map((warning) => warning.code).join(", ")}`);
  }
  if (citations.some((citation) => !citation.referenceIds.length)) {
    issues.push(`${citations.filter((citation) => !citation.referenceIds.length).length} unlinked citation anchor(s)`);
  }
  const orphaned = citations.flatMap((citation) => citation.referenceIds)
    .filter((referenceId) => !referenceIds.has(referenceId));
  if (orphaned.length) issues.push(`${orphaned.length} citation target(s) are absent from the bibliography`);
  if (citations.some((citation) => codeSentenceIds.has(citationSentence.get(citation.anchorId)))) {
    issues.push("a code paragraph contains a citation node");
  }
  checkUnique("section", sections.map((section) => section.id), issues);
  checkUnique("paragraph", paragraphs.map((paragraph) => paragraph.id), issues);
  checkUnique("sentence", sentences.map((sentence) => sentence.id), issues);
  checkUnique("citation anchor", citations.map((citation) => citation.anchorId), issues);
  checkUnique("reference", references.map((reference) => reference.id), issues);

  const sectionIds = new Set(sections.map((section) => section.id));
  if (sections.some((section) => section.parentId && !sectionIds.has(section.parentId))) {
    issues.push("a section points to a missing parent");
  }
  const serialized = JSON.stringify(paper);
  if (/[↩↪]/.test(serialized)) issues.push("return-arrow extraction artifact remains");
  if (sections.some((section) => /^([A-Z])\s+.+\s+\1\.\d+\s+/.test(section.title))) {
    issues.push("a combined appendix parent/subsection heading remains");
  }
  if (sections.some((section) => /^[\p{Ll}(]/u.test(section.title))) {
    issues.push("a lowercase or parenthetical layout fragment remains as a section heading");
  }
  if (sections.some((section) =>
    /^\s*(?:[A-HJ-UWYZ])\.\s+/u.test(section.title) && section.level < 2,
  )) {
    issues.push("an alphabetic subsection was promoted to a top-level section");
  }
  if (sections.some((section) =>
    /^\s*[IVXLCDM]+\..*\s(?:A|I)$/u.test(section.title),
  )) {
    issues.push("a major heading absorbed the first word of its body");
  }
  if (references.some((reference) => {
    const value = `${reference.raw ?? ""} ${reference.csl?.title ?? ""}`.trim();
    return /^#\s*(?:include|define|pragma)\b/i.test(value) ||
      /^\d+\s+(?:(?:unsigned|signed|register|static|const)\s+)*(?:char|int|long|short|size_t|uint\d+_t|void)\b/i.test(value) ||
      /^\*\s*\/\s*\d+\s+(?:(?:unsigned|signed|register|static|const)\s+)*(?:char|int|long|short|size_t|uint\d+_t|void)\b/i.test(value) ||
      /^\/\s*\*.*\*\s*\/\s*\d+\s+(?:void|char|int|size_t|uint\d+_t)\b/i.test(value) ||
      /^(?:void|int|char|size_t|uint\d+_t)\s+\w+\s*\([^)]*\)\s*\{/i.test(value);
  })) {
    issues.push("source code was promoted to a bibliography record");
  }

  return {
    filename,
    httpStatus,
    status: snapshot.status,
    sections: sections.length,
    references: references.length,
    anchors: citations.length,
    unresolvedReferences: references.filter((reference) => reference.status === "unresolved").length,
    warnings: paper.warnings.length,
    seconds: (elapsedMs / 1_000).toFixed(2),
    issues,
  };
}

function emptyResult(filename, snapshot, httpStatus, elapsedMs, issues) {
  return {
    filename,
    httpStatus,
    status: snapshot?.status ?? "missing",
    sections: 0,
    references: 0,
    anchors: 0,
    unresolvedReferences: 0,
    warnings: 0,
    seconds: (elapsedMs / 1_000).toFixed(2),
    issues,
  };
}

function checkUnique(label, values, issues) {
  if (new Set(values).size !== values.length) issues.push(`${label} IDs are not unique`);
}
