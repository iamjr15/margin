import {
  DOMParser,
  type Document as XmlDocument,
  type Element as XmlElement,
} from "@xmldom/xmldom";
import type {
  CslItem,
  InlineNode,
  Paper,
  Paragraph,
  ParseWarning,
  ReferenceRecord,
  Section,
  Sentence,
} from "@/lib/domain";
import { PaperSchema } from "@/lib/domain";
import { AppError } from "@/lib/errors";

interface Counters {
  section: number;
  paragraph: number;
  sentence: number;
  citation: number;
}

interface ProjectionContext {
  counters: Counters;
  warnings: ParseWarning[];
  references: Map<string, ReferenceRecord>;
  citationMarkers: string[];
}

export function projectTeiToPaper(tei: string, sourceSha256: string): Paper {
  const xml = new DOMParser().parseFromString(tei, "application/xml");
  if (xml.getElementsByTagName("parsererror").length > 0) {
    throw new AppError("tei_parse_failed", "The parser output could not be read.", 502);
  }

  const references = parseReferences(xml);
  const context: ProjectionContext = {
    counters: { section: 0, paragraph: 0, sentence: 0, citation: 0 },
    warnings: [],
    references: new Map(references.map((reference) => [reference.id, reference])),
    citationMarkers: [],
  };
  const header = first(xml, "teiHeader");
  const title = normalize(first(first(header, "fileDesc"), "titleStmt")?.textContent ?? "");
  const authors = parseHeaderAuthors(header);
  const abstract = parseAbstract(first(first(header, "profileDesc"), "abstract"), context);
  const sections = parseBody(first(first(xml.documentElement, "text"), "body"), context);

  if (!title) {
    context.warnings.push({ code: "missing_title", message: "The paper title was not detected." });
  }
  if (context.references.size === 0) {
    context.warnings.push({
      code: "missing_references",
      message: "No structured reference list was detected.",
    });
  }
  const style = detectCitationStyle(context.citationMarkers);
  return PaperSchema.parse({
    schemaVersion: 1,
    title: title || "Untitled paper",
    authors,
    abstract,
    sections,
    references: [...context.references.values()],
    warnings: context.warnings,
    citationStyle: style,
    provenance: {
      parser: "grobid",
      parserVersion: process.env.GROBID_VERSION ?? "0.9.1-crf",
      sourceSha256,
      parsedAt: new Date().toISOString(),
    },
  });
}

function parseReferences(xml: XmlDocument): ReferenceRecord[] {
  const entries = elements(xml, "listBibl").flatMap((list) => direct(list, "biblStruct"));
  return entries.map((entry, index) => {
    const id = xmlId(entry) || `ref-${index + 1}`;
    const analytic = first(entry, "analytic");
    const monograph = first(entry, "monogr");
    const articleTitle = findTitle(analytic, "a");
    const containerTitle = findTitle(monograph, "j") || findTitle(monograph, "m");
    const title = articleTitle || containerTitle || undefined;
    const authorRoot = analytic ?? monograph;
    const authors = authorRoot ? direct(authorRoot, "author").map(parseCslName) : [];
    const editorRoot = monograph;
    const editors = editorRoot ? direct(editorRoot, "editor").map(parseCslName) : [];
    const doi = findIdno(entry, "DOI");
    const raw = elements(entry, "note").find((note) => note.getAttribute("type") === "raw_reference");
    const year = parseYear(first(first(entry, "imprint"), "date"));
    const page = parsePage(first(entry, "imprint"));
    const csl: CslItem = {
      id,
      type: analytic ? inferAnalyticType(containerTitle) : "book",
      ...(title ? { title } : {}),
      ...(authors.length ? { author: authors } : {}),
      ...(editors.length ? { editor: editors } : {}),
      ...(containerTitle && articleTitle ? { "container-title": containerTitle } : {}),
      ...(year ? { issued: { "date-parts": [[year]] } } : {}),
      ...(doi ? { DOI: normalizeDoi(doi), URL: `https://doi.org/${normalizeDoi(doi)}` } : {}),
      ...scopeField(first(entry, "imprint"), "volume", "volume"),
      ...scopeField(first(entry, "imprint"), "issue", "issue"),
      ...(page ? { page } : {}),
    };
    const confidence = Math.min(1, (title ? 0.5 : 0) + (authors.length ? 0.25 : 0) + (year ? 0.15 : 0) + (doi ? 0.1 : 0));
    return {
      id,
      csl,
      raw: normalize(raw?.textContent ?? "") || undefined,
      status: title ? "parsed" : "unresolved",
      confidence,
      providerIds: {},
    };
  });
}

function parseHeaderAuthors(header: XmlElement | null): string[] {
  const source = first(first(header, "fileDesc"), "sourceDesc") ?? header;
  if (!source) return [];
  const analytic = first(source, "analytic");
  const authorElements = analytic ? direct(analytic, "author") : elements(source, "author");
  return authorElements
    .map((author) => {
      const name = parseCslName(author);
      return name.literal ?? [name.given, name.family].filter(Boolean).join(" ");
    })
    .filter(Boolean);
}

function parseAbstract(abstractElement: XmlElement | null, context: ProjectionContext): Paragraph[] {
  if (!abstractElement) return [];
  const paragraphs = elements(abstractElement, "p");
  return paragraphs.length
    ? paragraphs.map((paragraph) => parseParagraph(paragraph, context))
    : [parseParagraph(abstractElement, context)];
}

function parseBody(body: XmlElement | null, context: ProjectionContext): Section[] {
  if (!body) {
    context.warnings.push({ code: "missing_body", message: "No paper body was detected." });
    return [];
  }
  const sections: Section[] = [];
  const looseParagraphs = direct(body, "p");
  if (looseParagraphs.length) {
    sections.push({
      id: `section-${++context.counters.section}`,
      level: 1,
      title: "Body",
      paragraphs: looseParagraphs.map((paragraph) => parseParagraph(paragraph, context)),
    });
  }
  for (const division of direct(body, "div")) {
    parseDivision(division, 1, undefined, sections, context);
  }
  return sections;
}

function parseDivision(
  division: XmlElement,
  level: number,
  parentId: string | undefined,
  sections: Section[],
  context: ProjectionContext,
): void {
  const id = xmlId(division) || `section-${++context.counters.section}`;
  const heading = normalize(direct(division, "head")[0]?.textContent ?? "") || `Section ${sections.length + 1}`;
  const paragraphs = direct(division, "p").map((paragraph) => parseParagraph(paragraph, context));
  sections.push({ id, parentId, level, title: heading, paragraphs });
  for (const child of direct(division, "div")) {
    parseDivision(child, level + 1, id, sections, context);
  }
}

function parseParagraph(element: XmlElement, context: ProjectionContext): Paragraph {
  const id = xmlId(element) || `paragraph-${++context.counters.paragraph}`;
  const sentenceElements = direct(element, "s");
  const sentences = sentenceElements.length
    ? sentenceElements.map((sentence) => parseSentence(sentence, context))
    : [parseSentence(element, context)];
  return { id, sentences: sentences.filter((sentence) => sentence.nodes.length > 0) };
}

function parseSentence(element: XmlElement, context: ProjectionContext): Sentence {
  const id = xmlId(element) || `sentence-${++context.counters.sentence}`;
  return { id, nodes: normalizeInline(parseInlineChildren(element, context)) };
}

function parseInlineChildren(element: XmlElement, context: ProjectionContext): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (!child) continue;
    if (child.nodeType === 3) {
      nodes.push({ type: "text", value: child.nodeValue ?? "" });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const childElement = child as XmlElement;
    if (localName(childElement) === "ref" && childElement.getAttribute("type") === "bibr") {
      const anchorId = xmlId(childElement) || `citation-${++context.counters.citation}`;
      const raw = normalize(childElement.textContent ?? "");
      const targets = (childElement.getAttribute("target") ?? "")
        .split(/\s+/)
        .map((target) => target.replace(/^#/, ""))
        .filter(Boolean);
      const referenceIds = targets.length ? targets : [`unresolved-${anchorId}`];
      nodes.push({
        type: "citation",
        anchorId,
        referenceIds,
        raw,
        coordinates: childElement.getAttribute("coords") || undefined,
      });
      context.citationMarkers.push(raw);
      for (const referenceId of referenceIds) addUnknownReference(context, referenceId);
      if (!targets.length) {
        context.warnings.push({
          code: "unlinked_citation",
          message: `Citation marker “${raw || anchorId}” was not linked to a reference.`,
          anchorId,
        });
      }
      continue;
    }
    nodes.push(...parseInlineChildren(childElement, context));
  }
  return nodes;
}

function addUnknownReference(context: ProjectionContext, id: string): void {
  if (context.references.has(id)) return;
  context.references.set(id, {
    id,
    csl: { id, type: "document" },
    status: "unresolved",
    confidence: 0,
    providerIds: {},
  });
  context.warnings.push({
    code: "missing_reference_target",
    message: `Reference target “${id}” was not found in the bibliography.`,
    referenceId: id,
  });
}

function detectCitationStyle(markers: string[]): Paper["citationStyle"] {
  if (!markers.length) return { family: "unknown", cslId: "apa", confidence: 0 };
  const numeric = markers.filter((marker) => /^\s*(?:\[\d|\(\d|\d+[,.\]])/.test(marker)).length;
  const authorDate = markers.filter((marker) => /[A-Z][A-Za-z'-]+.*(?:19|20)\d{2}/.test(marker)).length;
  const strongest = Math.max(numeric, authorDate);
  const confidence = strongest / markers.length;
  if (confidence < 0.6) return { family: "unknown", cslId: "apa", confidence };
  return numeric >= authorDate
    ? { family: "numeric", cslId: "ieee", confidence }
    : { family: "author-date", cslId: "apa", confidence };
}

function parseCslName(author: XmlElement): { family?: string; given?: string; literal?: string } {
  const person = first(author, "persName");
  if (!person) return { literal: normalize(author.textContent ?? "") };
  const family = normalize(first(person, "surname")?.textContent ?? "") || undefined;
  const given = elements(person, "forename")
    .map((name) => normalize(name.textContent ?? ""))
    .filter(Boolean)
    .join(" ") || undefined;
  return family || given ? { family, given } : { literal: normalize(person.textContent ?? "") };
}

function findTitle(root: XmlElement | null, level: string): string {
  if (!root) return "";
  const candidate = elements(root, "title").find((title) => title.getAttribute("level") === level);
  return normalize(candidate?.textContent ?? "");
}

function findIdno(root: XmlElement, type: string): string {
  const candidate = elements(root, "idno").find(
    (idno) => (idno.getAttribute("type") ?? "").toUpperCase() === type.toUpperCase(),
  );
  return normalize(candidate?.textContent ?? "");
}

function parseYear(date: XmlElement | null): number | undefined {
  if (!date) return undefined;
  const value = date.getAttribute("when") ?? date.textContent ?? "";
  const match = value.match(/(?:19|20)\d{2}/);
  return match ? Number(match[0]) : undefined;
}

function parsePage(imprint: XmlElement | null): string | undefined {
  if (!imprint) return undefined;
  const scope = elements(imprint, "biblScope").find((item) => item.getAttribute("unit") === "page");
  if (!scope) return undefined;
  const from = scope.getAttribute("from");
  const to = scope.getAttribute("to");
  return from && to ? `${from}-${to}` : normalize(scope.textContent ?? "") || from || undefined;
}

function scopeField(
  imprint: XmlElement | null,
  unit: string,
  field: "volume" | "issue",
): Partial<CslItem> {
  if (!imprint) return {};
  const value = elements(imprint, "biblScope").find((item) => item.getAttribute("unit") === unit);
  const normalized = normalize(value?.textContent ?? "");
  return normalized ? { [field]: normalized } : {};
}

function inferAnalyticType(containerTitle: string): string {
  return /proceedings|conference|workshop/i.test(containerTitle) ? "paper-conference" : "article-journal";
}

function normalizeInline(nodes: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const value = node.value.replace(/\s+/g, " ");
      const previous = merged.at(-1);
      if (previous?.type === "text") previous.value += value;
      else if (value) merged.push({ type: "text", value });
    } else {
      merged.push(node);
    }
  }
  if (merged[0]?.type === "text") merged[0].value = merged[0].value.trimStart();
  const last = merged.at(-1);
  if (last?.type === "text") last.value = last.value.trimEnd();
  return merged.filter((node) => node.type !== "text" || node.value.length > 0);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeDoi(value: string): string {
  return value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim().toLowerCase();
}

function localName(element: XmlElement): string {
  return element.localName || element.nodeName.replace(/^.*:/, "");
}

function xmlId(element: XmlElement): string {
  return element.getAttribute("xml:id") ?? element.getAttribute("id") ?? "";
}

function elements(root: XmlDocument | XmlElement | null, name: string): XmlElement[] {
  if (!root) return [];
  const all = root.getElementsByTagName("*");
  const matches: XmlElement[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const element = all.item(index);
    if (element && localName(element) === name) matches.push(element);
  }
  return matches;
}

function direct(root: XmlElement | null, name: string): XmlElement[] {
  if (!root) return [];
  const matches: XmlElement[] = [];
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const node = root.childNodes.item(index);
    if (node?.nodeType === 1 && localName(node as XmlElement) === name) matches.push(node as XmlElement);
  }
  return matches;
}

function first(root: XmlDocument | XmlElement | null, name: string): XmlElement | null {
  return elements(root, name)[0] ?? null;
}
