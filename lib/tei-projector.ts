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
  recoveredHeadings: number;
  unlinkedCitations: number;
  lastExplicitSectionLevel?: number;
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
    recoveredHeadings: 0,
    unlinkedCitations: 0,
  };
  const header = first(xml, "teiHeader");
  const titleStmt = first(first(header, "fileDesc"), "titleStmt");
  const titleElement = direct(titleStmt, "title").find(
    (candidate) => !candidate.getAttribute("type") || candidate.getAttribute("type") === "main",
  );
  const title = normalizeExtractedText(titleElement?.textContent ?? "");
  const authors = parseHeaderAuthors(header);
  const abstract = parseAbstract(first(first(header, "profileDesc"), "abstract"), context);
  const text = first(xml.documentElement, "text");
  let sections = parseBody(first(text, "body"), context);
  parseBackMatter(first(text, "back"), sections, context);
  sections = reparentSections(recoverInlineMajorHeadings(sections, context));

  if (context.unlinkedCitations) {
    context.warnings.push({
      code: "unlinked_citations",
      message: `${context.unlinkedCitations} citation callout${context.unlinkedCitations === 1 ? " was" : "s were"} preserved verbatim because no unique bibliography target could be established.`,
    });
  }

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
    identifiers: parseDocumentIdentifiers(header),
    warnings: context.warnings,
    citationStyle: style,
    provenance: {
      parser: "grobid",
      parserVersion: process.env.GROBID_VERSION ?? "0.9.1-crf",
      sourceSha256,
      parsedAt: new Date().toISOString(),
      recoveredPseudoHeadings: context.recoveredHeadings,
    },
  });
}

function parseReferences(xml: XmlDocument): ReferenceRecord[] {
  const entries = elements(xml, "listBibl").flatMap((list) => direct(list, "biblStruct"));
  return entries.flatMap((entry, index) => {
    const id = xmlId(entry) || `ref-${index + 1}`;
    const analytic = first(entry, "analytic");
    const monograph = first(entry, "monogr");
    const articleTitle = findTitle(analytic, "a");
    const containerTitle = findTitle(monograph, "j") || findTitle(monograph, "m");
    const rawElement = elements(entry, "note").find(
      (note) => note.getAttribute("type") === "raw_reference",
    );
    const extractedRaw = normalizeRawReference(rawElement?.textContent ?? "") || undefined;
    const rawFragments = splitMergedRawReferences(extractedRaw);
    const raw = rawFragments[0] ?? extractedRaw;
    const authorRoot = analytic ?? monograph;
    const parsedAuthors = authorRoot ? direct(authorRoot, "author").map(parseCslName) : [];
    const editorRoot = monograph;
    const editors = editorRoot ? direct(editorRoot, "editor").map(parseCslName) : [];
    const doi = findIdno(entry, "DOI");
    const rawUrl = extractRawReferenceUrl(raw);
    const inferredRawTitle = inferTitleFromRawReference(raw, parsedAuthors) || undefined;
    const structuredTitle = cleanStructuredReferenceTitle(
      articleTitle || containerTitle,
      parsedAuthors,
    );
    const title = rawFragments.length > 1
      ? inferredRawTitle || structuredTitle
      : structuredTitle || inferredRawTitle;
    const authors = recoverAuthorsFromRawReference(raw, title, parsedAuthors).filter((author) =>
      !(/^\s*(?:available(?:\s+at)?|url)\s*:/i.test(raw ?? "") &&
        normalizeName(author.family ?? author.literal ?? "") === "available"),
    );
    const year = rawFragments.length > 1
      ? parseYearText(raw)
      : parseYear(first(first(entry, "imprint"), "date")) ?? parseYearText(raw);
    const page = parsePage(first(entry, "imprint"));
    const csl: CslItem = {
      id,
      type: analytic ? inferAnalyticType(containerTitle) : "book",
      ...(title ? { title } : {}),
      ...(authors.length ? { author: authors } : {}),
      ...(editors.length ? { editor: editors } : {}),
      ...(rawFragments.length <= 1 && containerTitle && articleTitle
        ? { "container-title": containerTitle }
        : {}),
      ...(year ? { issued: { "date-parts": [[year]] } } : {}),
      ...(doi
        ? { DOI: normalizeDoi(doi), URL: `https://doi.org/${normalizeDoi(doi)}` }
        : rawUrl ? { URL: rawUrl } : {}),
      ...(rawFragments.length <= 1 ? scopeField(first(entry, "imprint"), "volume", "volume") : {}),
      ...(rawFragments.length <= 1 ? scopeField(first(entry, "imprint"), "issue", "issue") : {}),
      ...(rawFragments.length <= 1 && page ? { page } : {}),
    };
    const confidence = Math.min(1, (title ? 0.5 : 0) + (authors.length ? 0.25 : 0) + (year ? 0.15 : 0) + (doi ? 0.1 : 0) + (rawUrl ? 0.25 : 0));
    const primary: ReferenceRecord = {
      id,
      csl,
      raw,
      status: title || rawUrl ? "parsed" : "unresolved",
      confidence,
      providerIds: {},
    };
    return [
      ...(!isCodeLikeReference(primary) ? [primary] : []),
      ...rawFragments.slice(1).map((fragment, fragmentIndex) =>
        parseRawReference(fragment, `${id}-split-${fragmentIndex + 2}`),
      ).filter((reference) => !isCodeLikeReference(reference)),
    ];
  });
}

function isCodeLikeReference(reference: ReferenceRecord): boolean {
  const value = normalize(reference.raw ?? reference.csl.title ?? "");
  return (
    /^#\s*(?:include|define|pragma)\b/i.test(value) ||
    /^\d+\s+(?:(?:unsigned|signed|register|static|const)\s+)*(?:char|int|long|short|size_t|uint\d+_t|void)\b/i.test(value) ||
    /^\*\s*\/\s*\d+\s+(?:(?:unsigned|signed|register|static|const)\s+)*(?:char|int|long|short|size_t|uint\d+_t|void)\b/i.test(value) ||
    /^\/\s*\*.*\*\s*\/\s*\d+\s+(?:void|char|int|size_t|uint\d+_t)\b/i.test(value) ||
    /^(?:void|int|char|size_t|uint\d+_t)\s+\w+\s*\([^)]*\)\s*\{/i.test(value) ||
    /\bif\s*\([^)]*\)\s*\{[^}]*\b(?:array|return|uint|size_t)\b/i.test(value)
  );
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
      paragraphs: looseParagraphs.map((paragraph) =>
        parseParagraph(paragraph, context, inferParagraphKind(paragraph)),
      ),
    });
  }
  const divisions = direct(body, "div");
  const repeatedHeadings = findRepeatedUnnumberedHeadings(divisions);
  for (const division of divisions) {
    parseDivision(division, 1, undefined, sections, context, repeatedHeadings);
  }
  return sections;
}

function parseBackMatter(
  back: XmlElement | null,
  sections: Section[],
  context: ProjectionContext,
): void {
  if (!back) return;
  const divisions: XmlElement[] = [];
  for (const division of direct(back, "div")) {
    collectBackMatterDivisions(division, divisions, sections, context);
  }
  const repeatedHeadings = findRepeatedUnnumberedHeadings(divisions);
  for (const division of divisions) {
    parseDivision(division, 1, undefined, sections, context, repeatedHeadings);
  }
}

function collectBackMatterDivisions(
  division: XmlElement,
  divisions: XmlElement[],
  sections: Section[],
  context: ProjectionContext,
): void {
  const type = normalize(division.getAttribute("type") ?? "").toLocaleLowerCase();
  if (type === "references" || direct(division, "listBibl").length) {
    return;
  }
  if (/^acknowledg(?:e)?ments?$/.test(type)) {
    sections.push({
      id: xmlId(division) || `section-${++context.counters.section}`,
      level: 1,
      title: "Acknowledgments",
      // GROBID may create name-like child heads at a column break. A TEI
      // acknowledgement is one semantic unit, so its paragraphs are flattened.
      paragraphs: elements(division, "p").map((paragraph) =>
        parseParagraph(paragraph, context, inferParagraphKind(paragraph)),
      ),
    });
    return;
  }
  if (direct(division, "head").length) {
    divisions.push(division);
    return;
  }

  const looseParagraphs = direct(division, "p");
  if (looseParagraphs.length) {
    sections.push({
      id: xmlId(division) || `section-${++context.counters.section}`,
      level: 1,
      title: type ? titleCase(type) : "Back matter",
      paragraphs: elements(division, "p").map((paragraph) =>
        parseParagraph(paragraph, context, inferParagraphKind(paragraph)),
      ),
    });
    return;
  }

  for (const child of direct(division, "div")) {
    collectBackMatterDivisions(child, divisions, sections, context);
  }
}

function parseDivision(
  division: XmlElement,
  level: number,
  parentId: string | undefined,
  sections: Section[],
  context: ProjectionContext,
  repeatedHeadings: Set<string>,
): void {
  const id = xmlId(division) || `section-${++context.counters.section}`;
  const head = direct(division, "head")[0] ?? null;
  const rawHeading = normalize(head?.textContent ?? "");
  const headNumber = normalizeSectionNumber(head?.getAttribute("n") ?? "");
  const childDivisions = direct(division, "div");
  const hasDirectContent = direct(division, "p").length > 0 || childDivisions.length > 0;
  const repeatedRunningHead = !headNumber && !hasTextualOutlineMarker(rawHeading) && repeatedHeadings.has(headingKey(rawHeading));
  if (!isStructuralHeading(rawHeading, headNumber, hasDirectContent) || repeatedRunningHead) {
    const codeLike = isCodeArtifactHeading(rawHeading);
    const destination = sections.at(-1);
    const repairedFragment = Boolean(
      destination && !repeatedRunningHead && mergeHyphenatedHeadingFragment(destination, rawHeading),
    );
    const preserveHead = Boolean(
      head &&
      meaningfulArtifactText(rawHeading) &&
      !repeatedRunningHead &&
      !repairedFragment &&
      !isDiscardableLayoutHeading(rawHeading, hasDirectContent),
    );
    const recovered = [
      ...(preserveHead
        ? [parseParagraph(head, context, codeLike ? "code" : "prose")]
        : []),
      ...direct(division, "p").map((paragraph) =>
        parseParagraph(paragraph, context, inferParagraphKind(paragraph)),
      ),
    ];
    if (recovered.length) {
      if (destination) destination.paragraphs.push(...recovered);
      else {
        sections.push({
          id,
          level: 1,
          title: "Extracted content",
          paragraphs: recovered,
        });
      }
    }
    context.recoveredHeadings += 1;
    for (const child of childDivisions) {
      parseDivision(child, level, parentId, sections, context, repeatedHeadings);
    }
    return;
  }

  const heading = normalizeExtractedText(rawHeading) || `Section ${sections.length + 1}`;
  const combinedAppendix = splitCombinedAppendixHeading(heading);
  if (combinedAppendix) {
    let appendixParent = sections.find((section) => section.title === combinedAppendix.parentTitle);
    if (!appendixParent) {
      appendixParent = {
        id: `${id}-parent`,
        parentId,
        level: 1,
        title: combinedAppendix.parentTitle,
        paragraphs: [],
      };
      sections.push(appendixParent);
    }
    const paragraphs = direct(division, "p").map((paragraph) =>
      parseParagraph(paragraph, context, inferParagraphKind(paragraph)),
    );
    const childLevel = Math.min(6, appendixParent.level + 1);
    sections.push({
      id,
      parentId: appendixParent.id,
      level: childLevel,
      title: combinedAppendix.childTitle,
      paragraphs,
    });
    for (const child of direct(division, "div")) {
      parseDivision(child, childLevel + 1, id, sections, context, repeatedHeadings);
    }
    context.lastExplicitSectionLevel = childLevel;
    return;
  }
  const explicitLevel = inferExplicitSectionLevel(heading, headNumber);
  const inferredLevel = explicitLevel ?? Math.min(
    6,
    parentId ? level : (context.lastExplicitSectionLevel ?? Math.max(0, level - 1)) + 1,
  );
  if (explicitLevel) context.lastExplicitSectionLevel = explicitLevel;
  const inferredParent =
    parentId ?? [...sections].reverse().find((section) => section.level < inferredLevel)?.id;
  const paragraphs = direct(division, "p").map((paragraph) =>
    parseParagraph(paragraph, context, inferParagraphKind(paragraph)),
  );
  sections.push({ id, parentId: inferredParent, level: inferredLevel, title: heading, paragraphs });
  for (const child of childDivisions) {
    parseDivision(child, inferredLevel + 1, id, sections, context, repeatedHeadings);
  }
}

function splitCombinedAppendixHeading(
  heading: string,
): { parentTitle: string; childTitle: string } | null {
  const match = heading.match(/^([A-Z])\s+(.+?)\s+\1\.(\d+(?:\.\d+)*)\s+(.+)$/);
  if (!match) return null;
  return {
    parentTitle: `${match[1]} ${match[2]}`,
    childTitle: `${match[1]}.${match[3]} ${match[4]}`,
  };
}

function parseParagraph(
  element: XmlElement,
  context: ProjectionContext,
  kind: Paragraph["kind"] = "prose",
): Paragraph {
  const id = xmlId(element) || `paragraph-${++context.counters.paragraph}`;
  const sentenceElements = direct(element, "s");
  const sentences = sentenceElements.length
    ? sentenceElements.map((sentence) => parseSentence(sentence, context, kind === "prose"))
    : [parseSentence(element, context, kind === "prose")];
  return { id, kind, sentences: sentences.filter((sentence) => sentence.nodes.length > 0) };
}

function parseSentence(
  element: XmlElement,
  context: ProjectionContext,
  interpretCitations: boolean,
): Sentence {
  const id = xmlId(element) || `sentence-${++context.counters.sentence}`;
  let nodes = normalizeInline(parseInlineChildren(element, context, interpretCitations));
  if (interpretCitations) nodes = resolveUnlinkedCitationNodes(nodes, context);
  return { id, nodes };
}

function parseInlineChildren(
  element: XmlElement,
  context: ProjectionContext,
  interpretCitations: boolean,
): InlineNode[] {
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
    if (
      interpretCitations &&
      localName(childElement) === "ref" &&
      childElement.getAttribute("type") === "bibr"
    ) {
      const anchorId = xmlId(childElement) || `citation-${++context.counters.citation}`;
      const raw = normalize(childElement.textContent ?? "");
      const targets = (childElement.getAttribute("target") ?? "")
        .split(/\s+/)
        .map((target) => target.replace(/^#/, ""))
        .filter(Boolean);
      const referenceIds = targets.filter((target) => context.references.has(target));
      nodes.push({
        type: "citation",
        anchorId,
        referenceIds,
        raw,
        coordinates: childElement.getAttribute("coords") || undefined,
      });
      continue;
    }
    nodes.push(...parseInlineChildren(childElement, context, interpretCitations));
  }
  return nodes;
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
  if (!person) return { literal: normalizeExtractedText(author.textContent ?? "") };
  const family = normalizeExtractedText(first(person, "surname")?.textContent ?? "") || undefined;
  const given = elements(person, "forename")
    .map((name) => normalizeExtractedText(name.textContent ?? ""))
    .filter(Boolean)
    .join(" ") || undefined;
  return family || given
    ? { family, given }
    : { literal: normalizeExtractedText(person.textContent ?? "") };
}

function findTitle(root: XmlElement | null, level: string): string {
  if (!root) return "";
  const candidate = elements(root, "title").find((title) => title.getAttribute("level") === level);
  return normalizeExtractedText(candidate?.textContent ?? "");
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

function resolveUnlinkedCitationNodes(nodes: InlineNode[], context: ProjectionContext): InlineNode[] {
  const resolvedNodes: InlineNode[] = [];
  let previousReferenceIds: string[] = [];
  let previousRaw = "";
  for (const node of nodes) {
    if (node.type !== "citation") {
      resolvedNodes.push(node);
      continue;
    }
    if (!node.referenceIds.length) {
      node.referenceIds = inferReferenceIdsFromMarker(
        node.raw,
        [...context.references.values()],
        previousReferenceIds,
        previousRaw,
      );
    }
    if (!node.referenceIds.length && !isPlausibleCitationMarker(node.raw, previousRaw)) {
      resolvedNodes.push({ type: "text", value: node.raw });
      continue;
    }
    if (!node.referenceIds.length) context.unlinkedCitations += 1;
    else previousReferenceIds = node.referenceIds;
    context.citationMarkers.push(node.raw);
    resolvedNodes.push(node);
    previousRaw = node.raw;
  }
  return normalizeInline(resolvedNodes);
}

function inferReferenceIdsFromMarker(
  marker: string,
  references: ReferenceRecord[],
  previousReferenceIds: string[],
  previousRaw: string,
): string[] {
  const numeric = marker.match(/^\s*[[(]?\s*(\d{1,4})\s*(?:[,;]|[\])])?\s*$/);
  if (numeric) return references[Number(numeric[1]) - 1] ? [references[Number(numeric[1]) - 1]!.id] : [];

  let yearToken = marker.match(/\b((?:19|20)\d{2}[a-z]?)\b/i)?.[1]?.toLowerCase();
  let surnames = citationSurnames(marker, yearToken);
  if (!yearToken && /^\s*[a-z]\s*[;,)\]]?\s*$/i.test(marker)) {
    const previousYear = previousRaw.match(/\b((?:19|20)\d{2})[a-z]?\b/i)?.[1];
    if (previousYear) yearToken = `${previousYear}${marker.match(/[a-z]/i)?.[0].toLowerCase()}`;
  }
  if (!surnames.length && previousReferenceIds.length) {
    surnames = firstAuthorFamilies(references.filter((reference) => previousReferenceIds.includes(reference.id)));
  }
  if (!yearToken || !surnames.length) return [];

  const candidates = references.filter((reference) => {
    if (referenceYearToken(reference) !== yearToken) return false;
    if (
      /\bet\s+al\b/i.test(marker) &&
      (reference.csl.author?.length ?? 0) < 3 &&
      !/\bet\s+al\./i.test(reference.raw ?? "")
    ) return false;
    const families = reference.csl.author?.flatMap((author) =>
      normalizeName(author.family ?? author.literal ?? "") ? [normalizeName(author.family ?? author.literal ?? "")] : [],
    ) ?? [];
    return families[0] === surnames[0] && surnames.slice(1).every((surname) => families.includes(surname));
  });
  return candidates.length === 1 ? [candidates[0]!.id] : [];
}

function isPlausibleCitationMarker(marker: string, previousRaw: string): boolean {
  if (/^\s*[[(]?\s*\d{1,4}\s*(?:[,;]|[\])])?\s*$/.test(marker)) return true;
  if (/\b(?:19|20)\d{2}[a-z]?\b/i.test(marker) && /\p{L}{2}/u.test(marker)) return true;
  return /^\s*[a-z]\s*[;,\])]?\s*$/i.test(marker) && /\b(?:19|20)\d{2}[a-z]?\b/i.test(previousRaw);
}

function citationSurnames(marker: string, yearToken: string | undefined): string[] {
  if (!yearToken) return [];
  const authorPart = marker.slice(0, marker.toLowerCase().indexOf(yearToken.slice(0, 4)))
    .replace(/\b(?:and also|et\s+al)\b/gi, " ")
    .replace(/[^\p{L}&'’-]+/gu, " ")
    .trim();
  if (!authorPart) return [];
  return authorPart
    .split(/\s*&\s*|\s+and\s+/i)
    .map((part) => normalizeName(part.trim().split(/\s+/).at(-1) ?? ""))
    .filter(Boolean);
}

function firstAuthorFamilies(references: ReferenceRecord[]): string[] {
  return references.flatMap((reference) => {
    const author = reference.csl.author?.[0];
    const family = normalizeName(author?.family ?? author?.literal ?? "");
    return family ? [family] : [];
  });
}

function referenceYearToken(reference: ReferenceRecord): string | undefined {
  const suffixedRawYear = reference.raw?.match(/\b((?:19|20)\d{2}[a-z])\b/i)?.[1]?.toLowerCase();
  if (suffixedRawYear) return suffixedRawYear;
  const year = reference.csl.issued?.["date-parts"]?.[0]?.[0];
  if (year) return String(year);
  const rawYears = [...(reference.raw ?? "").matchAll(/\b((?:19|20)\d{2})\b/g)];
  return rawYears.at(-1)?.[1];
}

function normalizeName(value: string): string {
  return value.normalize("NFKD").replace(/[^A-Za-z]/g, "").toLowerCase();
}

function normalizeInline(nodes: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const value = normalizeExtractedText(node.value, false);
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

function normalizeExtractedText(value: string, trim = true): string {
  let cleaned = normalizeTeXAccents(value)
    .replace(/\\n/g, " ")
    .replace(/(?:↩\s*→\s*)+/g, " ")
    .replace(/↩/g, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?:^|\s)#{1,6}\s+/g, " ")
    .replace(/-{5,}/g, " — ")
    .replace(/\s+/g, " ");
  if (trim) cleaned = cleaned.trim();
  return cleaned;
}

function normalizeRawReference(value: string): string {
  return normalizeExtractedText(value).replace(/([\p{L}])-\s+([\p{Ll}])/gu, "$1$2");
}

function normalizeTeXAccents(value: string): string {
  const diaeresis: Record<string, string> = {
    a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", y: "ÿ",
    A: "Ä", E: "Ë", I: "Ï", O: "Ö", U: "Ü", Y: "Ÿ",
  };
  const acute: Record<string, string> = {
    a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý",
    A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", Y: "Ý",
  };
  return value
    .replace(/\\+"\s*([A-Za-z])/g, (_, letter: string) => diaeresis[letter] ?? letter)
    .replace(/\\+'\s*([A-Za-z])/g, (_, letter: string) => acute[letter] ?? letter);
}

function cleanStructuredReferenceTitle(
  value: string,
  authors: CslItem["author"],
): string | undefined {
  const title = normalizeExtractedText(value);
  if (!title) return undefined;

  const firstSentenceEnd = title.indexOf(". ");
  if (firstSentenceEnd < 0) return title;
  const possibleAuthorPrefix = title.slice(0, firstSentenceEnd);
  const actualTitle = title.slice(firstSentenceEnd + 2).trim();
  if (actualTitle.length < 4) return title;

  const prefixKey = normalizeName(possibleAuthorPrefix);
  const authorFamilies = authors?.flatMap((author) => {
    const family = normalizeName(author.family ?? author.literal ?? "");
    return family.length >= 3 ? [family] : [];
  }) ?? [];
  const parsedAuthorSpill = authorFamilies.some((family) => prefixKey.includes(family));
  return parsedAuthorSpill || looksLikeTrailingAuthorList(possibleAuthorPrefix)
    ? actualTitle
    : title;
}

function looksLikeTrailingAuthorList(value: string): boolean {
  if (!/,\s+and\s+/i.test(value)) return false;
  const names = value
    .split(/,\s+(?:and\s+)?|\s+and\s+/i)
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length >= 2 && names.every((name) => {
    const parts = name.split(/\s+/).filter(Boolean);
    return parts.length >= 2 && parts.length <= 5 && parts.every((part) =>
      /^(?:[\p{Lu}][\p{L}'’.-]*|[\p{Lu}]\.)$/u.test(part),
    );
  });
}

function recoverAuthorsFromRawReference(
  raw: string | undefined,
  title: string | undefined,
  parsedAuthors: NonNullable<CslItem["author"]>,
): NonNullable<CslItem["author"]> {
  if (!raw || !title) return parsedAuthors;
  const titleIndex = raw.toLocaleLowerCase().indexOf(title.toLocaleLowerCase());
  if (titleIndex <= 0) return parsedAuthors;
  const authorText = raw.slice(0, titleIndex).replace(/[.\s]+$/, "");
  const recovered = authorText
    .split(/,\s+(?:and\s+)?|\s+and\s+/i)
    .map(parseRawPersonName)
    .filter((author): author is NonNullable<CslItem["author"]>[number] => Boolean(author));
  return recovered.length >= parsedAuthors.length && recovered.length <= parsedAuthors.length + 3
    ? recovered
    : parsedAuthors;
}

function parseRawPersonName(
  value: string,
): NonNullable<CslItem["author"]>[number] | undefined {
  const parts = value
    .replace(/\bet\s+al\.?$/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return undefined;
  if (parts.length === 1) return { literal: parts[0] };
  return { family: parts.at(-1), given: parts.slice(0, -1).join(" ") };
}

function isStructuralHeading(
  value: string,
  headNumber: string | undefined,
  hasDirectContent: boolean,
): boolean {
  if (!value || value.length > 180 || value.split(/\s+/).length > 24) return false;
  if (headNumber) return !isCodeArtifactHeading(value);
  if (!hasDirectContent || /^[\p{Ll}(]/u.test(value)) return false;
  if (!/[\p{L}]{2}/u.test(value)) return false;
  return !isCodeArtifactHeading(value);
}

function isCodeArtifactHeading(value: string): boolean {
  return (
    /↩|\\n|#{1,6}\s|\{[^}]+\}|-{5,}/.test(value) ||
    /\bif\s*\([^)]*\).+\bif\s*\(/i.test(value) ||
    /\b(?:coding agent implementation|agent running log|predicted patch|private test patch|issue test results)\b/i.test(value) ||
    /\bRan\s+↩|^\s*[↪↩→←⏎\s]+$/.test(value)
  );
}

function inferParagraphKind(element: XmlElement): Paragraph["kind"] {
  const value = element.textContent ?? "";
  const codeSignals = [
    /↩|\\n|@pytest\b|\bpytest\./i,
    /\b(?:def|elif|kwargs|path_obj|old_str|new_str|insert_line|view_range)\b/,
    /["'](?:type|description|properties|command)["']\s*:/,
    /(?:^|\s)[+]{1,3}\s+(?:return|if|elif|raise|["'])/m,
    /-{5,}|\{(?:code|md_log|github_issue|predicted_patch|test_patch|eval_log)\}/i,
  ].filter((pattern) => pattern.test(value)).length;
  return codeSignals > 0 ? "code" : "prose";
}

function meaningfulArtifactText(value: string): boolean {
  return /[\p{L}\p{N}]{2}/u.test(normalizeExtractedText(value));
}

function inferExplicitSectionLevel(
  heading: string,
  headNumber: string | undefined,
): number | undefined {
  if (headNumber) return Math.min(6, headNumber.split(".").length);
  const numeric = heading.match(/^\s*(\d+(?:\.\d+)*)(?:[.)])\s+/)?.[1];
  if (numeric) return Math.min(6, numeric.split(".").length);
  // C., D., L., and M. are overwhelmingly more likely to be alphabetic
  // subsections than the 100th, 500th, 50th, or 1000th Roman section.
  if (/^\s*(?:I|V|X|[IVXLCDM]{2,})\.\s+/u.test(heading)) return 1;
  const appendixChild = heading.match(/^\s*[A-Z]\.(\d+(?:\.\d+)*)\s+/)?.[1];
  if (appendixChild) return Math.min(6, appendixChild.split(".").length + 1);
  if (/^\s*[A-Z]\.\s+/u.test(heading)) return 2;
  if (/^\s*APPENDIX\b/u.test(heading)) return 1;
  const letters = heading.replace(/[^\p{L}]+/gu, "");
  if (letters && letters === letters.toUpperCase()) return 1;
  return undefined;
}

function normalizeSectionNumber(value: string): string | undefined {
  return normalize(value).match(/^(\d+(?:\.\d+)*)(?:\.)?$/)?.[1];
}

function titleCase(value: string): string {
  return value.replace(/(^|[\s_-])(\p{L})/gu, (_, boundary: string, letter: string) =>
    `${boundary === "_" || boundary === "-" ? " " : boundary}${letter.toLocaleUpperCase()}`,
  );
}

function hasTextualOutlineMarker(value: string): boolean {
  return /^(?:\d+(?:\.\d+)*[.)]|[IVXLCDM]+\.|[A-Z]\.|APPENDIX\b)\s*/u.test(value);
}

function headingKey(value: string): string {
  return normalizeExtractedText(value).toLocaleLowerCase();
}

function findRepeatedUnnumberedHeadings(divisions: XmlElement[]): Set<string> {
  const occurrences = new Map<string, Array<{ page: number; y: number } | undefined>>();
  for (const division of divisions) {
    const head = direct(division, "head")[0];
    if (!head || normalizeSectionNumber(head.getAttribute("n") ?? "")) continue;
    const key = headingKey(head.textContent ?? "");
    if (key) occurrences.set(key, [...(occurrences.get(key) ?? []), firstCoordinate(head)]);
  }
  return new Set(
    [...occurrences]
      .filter(([, coordinates]) => {
        if (coordinates.length < 2) return false;
        const located = coordinates.filter((coordinate): coordinate is { page: number; y: number } => Boolean(coordinate));
        if (located.length !== coordinates.length) return true;
        const pages = new Set(located.map((coordinate) => coordinate.page));
        const verticalPositions = located.map((coordinate) => coordinate.y);
        return pages.size > 1 && Math.max(...verticalPositions) - Math.min(...verticalPositions) <= 24;
      })
      .map(([key]) => key),
  );
}

function firstCoordinate(element: XmlElement): { page: number; y: number } | undefined {
  const [page, , y] = (element.getAttribute("coords") ?? "").split(/[;,]/).map(Number);
  return Number.isFinite(page) && Number.isFinite(y) ? { page, y } : undefined;
}

function isDiscardableLayoutHeading(value: string, hasDirectContent: boolean): boolean {
  return (
    !hasDirectContent ||
    /^\([\p{Ll}][\p{L}\s-]*\)\.?$/u.test(value) ||
    /^[\d\s.,:%+-]+$/.test(value)
  );
}

function mergeHyphenatedHeadingFragment(section: Section, heading: string): boolean {
  const fragment = heading.match(/^([\p{Ll}]{2,})([.!?]?)$/u);
  if (!fragment) return false;
  for (const paragraph of [...section.paragraphs].reverse()) {
    for (const sentence of [...paragraph.sentences].reverse()) {
      for (const node of [...sentence.nodes].reverse()) {
        if (node.type !== "text" || !/[\p{L}]{2,}-(?=\p{Lu}|\s|$)/u.test(node.value)) continue;
        node.value = node.value.replace(
          /([\p{L}]{2,})-(?=\p{Lu}|\s|$)(?![\s\S]*[\p{L}]{2,}-(?=\p{Lu}|\s|$))/u,
          `$1${fragment[1]}${fragment[2]}`,
        );
        return true;
      }
    }
  }
  return false;
}

interface SentencePosition {
  paragraphIndex: number;
  sentence: Sentence;
}

interface InlineMajorHeading {
  headingIndex: number;
  afterIndex: number;
  replacementIndex?: number;
  beforeText: string;
  afterText?: string;
  title: string;
}

function recoverInlineMajorHeadings(
  sections: Section[],
  context: ProjectionContext,
): Section[] {
  const recovered: Section[] = [];
  for (const section of sections) {
    let current = section;
    while (true) {
      const positions = sentencePositions(current.paragraphs);
      const heading = findInlineMajorHeading(positions);
      if (!heading) break;
      const slug = heading.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const before = rebuildParagraphSlice(
        current.paragraphs,
        positions,
        0,
        heading.headingIndex + 1,
        heading.beforeText,
        undefined,
      );
      const after = rebuildParagraphSlice(
        current.paragraphs,
        positions,
        heading.afterIndex,
        positions.length,
        undefined,
        heading.replacementIndex === heading.afterIndex ? heading.afterText : undefined,
        `after-${slug}`,
      );
      if (before.some((paragraph) => paragraph.sentences.length)) {
        recovered.push({ ...current, paragraphs: before });
      }
      current = {
        id: `${current.id}-inline-${slug}`,
        level: 1,
        title: heading.title,
        paragraphs: after,
      };
      context.recoveredHeadings += 1;
    }
    recovered.push(current);
  }
  return recovered;
}

function findInlineMajorHeading(
  positions: SentencePosition[],
): InlineMajorHeading | undefined {
  for (let index = 0; index < positions.length; index += 1) {
    const sentence = positions[index]!.sentence;
    if (!sentence.nodes.every((node) => node.type === "text")) continue;
    const text = sentence.nodes.map((node) => node.type === "text" ? node.value : "").join("");
    const complete = text.match(/(?:^|\s)([IVXLCDM]{1,8})\.\s+([A-Z][A-Z0-9]*(?:[ :–—-]+[A-Z0-9][A-Z0-9]*)*)\s*$/u);
    if (complete?.index !== undefined) {
      return {
        headingIndex: index,
        afterIndex: index + 1,
        beforeText: text.slice(0, complete.index).trimEnd(),
        title: `${complete[1]}. ${complete[2].trim()}`,
      };
    }

    const prefixedMarker = text.match(/^\s*([IVXLCDM]{1,8})\.\s+/u);
    if (prefixedMarker) {
      const remainder = text.slice(prefixedMarker[0].length);
      const prefix = leadingUppercaseHeading(remainder);
      if (prefix) {
        return {
          headingIndex: index,
          afterIndex: index,
          replacementIndex: index,
          beforeText: "",
          afterText: remainder.slice(prefix.length).trimStart(),
          title: `${prefixedMarker[1]}. ${prefix.trim()}`,
        };
      }
    }

    const marker = text.match(/(?:^|\s)([IVXLCDM]{1,8})\.\s*$/u);
    if (marker?.index === undefined) continue;
    const next = positions[index + 1]?.sentence;
    if (!next || !next.nodes.every((node) => node.type === "text")) continue;
    const nextText = next.nodes.map((node) => node.type === "text" ? node.value : "").join("");
    const prefix = leadingUppercaseHeading(nextText);
    if (!prefix) continue;
    return {
      headingIndex: index,
      afterIndex: index + 1,
      replacementIndex: index + 1,
      beforeText: text.slice(0, marker.index).trimEnd(),
      afterText: nextText.slice(prefix.length).trimStart(),
      title: `${marker[1]}. ${prefix.trim()}`,
    };
  }
  return undefined;
}

function leadingUppercaseHeading(value: string): string | undefined {
  const tokens = [...value.matchAll(/\S+/g)];
  let end = 0;
  for (const token of tokens) {
    if (!/^[A-Z][A-Z0-9-]*[,:]?$/u.test(token[0])) break;
    if (end > 0 && /^(?:A|I)$/u.test(token[0])) break;
    end = (token.index ?? 0) + token[0].length;
  }
  const heading = value.slice(0, end).trim();
  return /[A-Z]{3}/.test(heading) && value.slice(end).trim() ? heading : undefined;
}

function sentencePositions(paragraphs: Paragraph[]): SentencePosition[] {
  return paragraphs.flatMap((paragraph, paragraphIndex) =>
    paragraph.sentences.map((sentence) => ({ paragraphIndex, sentence })),
  );
}

function rebuildParagraphSlice(
  paragraphs: Paragraph[],
  positions: SentencePosition[],
  start: number,
  end: number,
  finalText?: string,
  firstText?: string,
  idSuffix?: string,
): Paragraph[] {
  const grouped = new Map<number, Sentence[]>();
  for (let index = start; index < end; index += 1) {
    const position = positions[index]!;
    let sentence = position.sentence;
    if (index === start && firstText !== undefined) sentence = sentenceWithText(sentence, firstText);
    if (index === end - 1 && finalText !== undefined) sentence = sentenceWithText(sentence, finalText);
    if (!sentence.nodes.length) continue;
    grouped.set(position.paragraphIndex, [...(grouped.get(position.paragraphIndex) ?? []), sentence]);
  }
  return [...grouped].map(([paragraphIndex, sentences]) => ({
    ...paragraphs[paragraphIndex]!,
    ...(idSuffix ? { id: `${paragraphs[paragraphIndex]!.id}-${idSuffix}` } : {}),
    sentences,
  }));
}

function sentenceWithText(sentence: Sentence, value: string): Sentence {
  return { ...sentence, nodes: value ? [{ type: "text", value }] : [] };
}

function reparentSections(sections: Section[]): Section[] {
  const output: Section[] = [];
  for (const section of sections) {
    const parent = [...output].reverse().find((candidate) => candidate.level < section.level);
    const next = { ...section };
    if (parent) next.parentId = parent.id;
    else delete next.parentId;
    output.push(next);
  }
  return output;
}

function inferTitleFromRawReference(
  raw: string | undefined,
  authors: CslItem["author"],
): string {
  if (!raw) return "";
  const firstAuthor = normalizeName(authors?.[0]?.family ?? authors?.[0]?.literal ?? "");
  const segments = raw.split(/\.\s+/).map((part) => normalizeExtractedText(part));
  return (
    segments.find((part, index) => {
      if (!part || /^https?:|^url\b|^accessed\b|^arxiv\b/i.test(part)) return false;
      if (/^(?:19|20)\d{2}[a-z]?\.?$/i.test(part)) return false;
      if (index === 0 && firstAuthor && normalizeName(part).includes(firstAuthor)) return false;
      return /[\p{L}]{2}/u.test(part);
    }) ?? ""
  );
}

function extractRawReferenceUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const available = raw.match(/^\s*(?:available(?:\s+at)?|url)\s*:\s*(https?:\/\/.+)\s*$/i)?.[1];
  const candidate = available?.replace(/\s+/g, "") ?? raw.match(/https?:\/\/[^\s]+/i)?.[0];
  if (!candidate) return undefined;
  try {
    return new URL(candidate.replace(/[),.;]+$/, "")).toString();
  } catch {
    return undefined;
  }
}

function splitMergedRawReferences(raw: string | undefined): string[] {
  if (!raw) return [];
  const marker = "\u0000REFERENCE_BOUNDARY\u0000";
  const separated = raw.replace(
    /\b((?:19|20)\d{2}[a-z]?\.)\s+(?=(?:[A-ZÀ-ÖØ-Þ][\p{L}'’.-]+\s+){1,4}(?:and\s+|et\s+al\.|[A-ZÀ-ÖØ-Þ][\p{L}'’.-]+,))/gu,
    `$1${marker}`,
  );
  return separated.split(marker).map((fragment) => fragment.trim()).filter(Boolean);
}

function parseRawReference(raw: string, id: string): ReferenceRecord {
  const authorMatch = raw.match(/^(.+?\bet\s+al\.)\s+(.+)$/i);
  const firstPeriod = raw.indexOf(". ");
  const authorText = authorMatch?.[1] ?? (firstPeriod >= 0 ? raw.slice(0, firstPeriod) : "");
  const remainder = authorMatch?.[2] ?? (firstPeriod >= 0 ? raw.slice(firstPeriod + 2) : raw);
  const title = normalizeExtractedText(remainder.split(/\.\s+/)[0] ?? "") || undefined;
  const authors = parseRawAuthorNames(authorText);
  const yearTokens = [...raw.matchAll(/\b((?:19|20)\d{2})[a-z]?\b/gi)];
  const year = yearTokens.at(-1)?.[1] ? Number(yearTokens.at(-1)![1]) : undefined;
  return {
    id,
    csl: {
      id,
      type: "article-journal",
      ...(title ? { title } : {}),
      ...(authors.length ? { author: authors } : {}),
      ...(year ? { issued: { "date-parts": [[year]] } } : {}),
    },
    raw,
    status: title ? "parsed" : "unresolved",
    confidence: title && authors.length && year ? 0.8 : title ? 0.55 : 0.2,
    providerIds: {},
  };
}

function parseRawAuthorNames(value: string): NonNullable<CslItem["author"]> {
  const cleaned = value.replace(/\bet\s+al\.?$/i, "").trim();
  const candidates = cleaned.includes(" and ")
    ? cleaned.split(/\s+and\s+/i)
    : [cleaned.split(/,\s*/)[0] ?? ""];
  return candidates.flatMap<NonNullable<CslItem["author"]>[number]>((candidate) => {
    const parts = candidate.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return [];
    if (parts.length === 1) return [{ literal: parts[0] }];
    return [{ family: parts.at(-1), given: parts.slice(0, -1).join(" ") }];
  });
}

function parseYearText(value: string | undefined): number | undefined {
  const match = value?.match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}

function parseDocumentIdentifiers(header: XmlElement | null): Record<string, string> {
  const source = first(first(header, "fileDesc"), "sourceDesc") ?? header;
  const identifiers: Record<string, string> = {};
  for (const idno of elements(source, "idno")) {
    const type = (idno.getAttribute("type") ?? "").trim().toLowerCase();
    const value = normalizeExtractedText(idno.textContent ?? "");
    if (!type || !value || identifiers[type]) continue;
    identifiers[type] = type === "doi" ? normalizeDoi(value) : value;
  }
  return identifiers;
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
