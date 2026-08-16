"use client";

import { AlertCircle, BookMarked, Braces, ChevronRight, FileCode2, FileDiff, Layers3 } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  CitationNode,
  DocumentSnapshot,
  Paragraph,
  ReferenceRecord,
  ReviewFinding,
  Sentence,
} from "@/lib/domain";
import { groupInlineNodes, sentenceText } from "@/lib/domain";
import { UploadSurface } from "@/components/upload-surface";

type PaperTab = "paper" | "citations" | "changes";

interface Props {
  snapshot: DocumentSnapshot | null;
  busyLabel: string | null;
  error: string | null;
  onStyleChange: (style: "apa" | "ieee") => Promise<void>;
  onUpload: (file: File) => Promise<void>;
}

export function PaperPane({ snapshot, busyLabel, error, onStyleChange, onUpload }: Props) {
  const [tab, setTab] = useState<PaperTab>("paper");
  const paper = snapshot?.paper;
  if (!paper) {
    return <UploadSurface busyLabel={busyLabel} error={error ?? snapshot?.error?.message ?? null} onUpload={onUpload} />;
  }
  return (
    <div className="paper-layout">
      <header className="paper-toolbar">
        <div className="paper-identity">
          <span className="status-dot complete" />
          <div><strong>{snapshot.filename}</strong><span>Version {snapshot.currentVersionId?.slice(0, 8)}</span></div>
        </div>
        <div className="paper-tabs" role="tablist" aria-label="Paper views">
          <Tab active={tab === "paper"} icon={<Layers3 size={14} />} label="Paper" onClick={() => setTab("paper")} />
          <Tab active={tab === "citations"} icon={<BookMarked size={14} />} label={`Citations ${paper.references.length}`} onClick={() => setTab("citations")} />
          <Tab active={tab === "changes"} icon={<FileDiff size={14} />} label="Changes" onClick={() => setTab("changes")} />
        </div>
      </header>
      <div className="panel-scroll paper-scroll">
        {busyLabel ? <div className="paper-busy-bar" aria-live="polite"><span />{busyLabel}</div> : null}
        {error ? (
          <div className="paper-error" role="alert">
            <AlertCircle aria-hidden="true" size={16} />
            <p><strong>Action needed</strong><span>{error}</span></p>
          </div>
        ) : null}
        {paper.warnings.length ? (
          <div className="parse-warning">
            <AlertCircle aria-hidden="true" size={16} />
            <p><strong>{paper.warnings.length} parse warning{paper.warnings.length === 1 ? "" : "s"}</strong><span>Nothing uncertain was silently dropped. See the citations view for details.</span></p>
          </div>
        ) : null}
        {tab === "paper" ? <PaperDocument snapshot={snapshot} /> : null}
        {tab === "citations" ? (
          <CitationLibrary
            disabled={Boolean(busyLabel) || Boolean(snapshot.proposal)}
            onStyleChange={onStyleChange}
            snapshot={snapshot}
          />
        ) : null}
        {tab === "changes" ? <ChangesView snapshot={snapshot} /> : null}
      </div>
    </div>
  );
}

function Tab({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button aria-selected={active} className={active ? "active" : ""} onClick={onClick} role="tab" type="button">{icon}{label}</button>;
}

function PaperDocument({ snapshot }: { snapshot: DocumentSnapshot }) {
  const paper = snapshot.paper;
  if (!paper) return null;
  const references = new Map(paper.references.map((reference) => [reference.id, reference]));
  const referenceNumbers = new Map(paper.references.map((reference, index) => [reference.id, index + 1]));
  const findings = new Map<string, ReviewFinding[]>();
  snapshot.review?.findings.forEach((finding) => findings.set(finding.sentenceId, [...(findings.get(finding.sentenceId) ?? []), finding]));
  return (
    <article className="paper-document paper-type">
      <header>
        <p className="paper-kicker">Parsed manuscript · {paper.citationStyle.family} citations · {Math.round(paper.citationStyle.confidence * 100)}% style confidence</p>
        <h1>{paper.title}</h1>
        {paper.authors.length ? <p className="paper-authors">{paper.authors.join(" · ")}</p> : null}
      </header>
      {paper.abstract.length ? (
        <section className="manuscript-section">
          <h2>Abstract</h2>
          <Paragraphs findings={findings} paragraphs={paper.abstract} referenceNumbers={referenceNumbers} references={references} style={paper.citationStyle.family} />
        </section>
      ) : null}
      {paper.sections.map((section) => (
        <section className="manuscript-section" data-level={section.level} key={section.id}>
          {section.level === 1 ? <h2>{section.title}</h2> : <h3>{section.title}</h3>}
          <Paragraphs findings={findings} paragraphs={section.paragraphs} referenceNumbers={referenceNumbers} references={references} style={paper.citationStyle.family} />
        </section>
      ))}
    </article>
  );
}

function Paragraphs({
  paragraphs,
  references,
  referenceNumbers,
  findings,
  style,
}: {
  paragraphs: Paragraph[];
  references: Map<string, ReferenceRecord>;
  referenceNumbers: Map<string, number>;
  findings: Map<string, ReviewFinding[]>;
  style: "numeric" | "author-date" | "unknown";
}) {
  const output: React.ReactNode[] = [];
  for (let index = 0; index < paragraphs.length;) {
    const paragraph = paragraphs[index]!;
    if (paragraph.kind === "code") {
      const codeParagraphs = [paragraph];
      while (paragraphs[index + codeParagraphs.length]?.kind === "code") {
        codeParagraphs.push(paragraphs[index + codeParagraphs.length]!);
      }
      output.push(<CodeArtifact key={paragraph.id} paragraphs={codeParagraphs} />);
      index += codeParagraphs.length;
      continue;
    }
    const content = paragraph.sentences.map((sentence) => (
      <SentenceView
        findings={findings.get(sentence.id) ?? []}
        key={sentence.id}
        referenceNumbers={referenceNumbers}
        references={references}
        sentence={sentence}
        style={style}
      />
    ));
    output.push(<p className="paper-paragraph" key={paragraph.id}>{content}</p>);
    index += 1;
  }
  return output;
}

function CodeArtifact({ paragraphs }: { paragraphs: Paragraph[] }) {
  const entries = paragraphs.map(paragraphText).filter(Boolean);
  const identifierEntries = entries.map((entry) => entry.replace(/^[•●▪◦*-]\s*/, ""));
  const isIdentifierList = identifierEntries.length > 1 && identifierEntries.every((entry) =>
    /^[A-Za-z0-9][\w./:+-]{2,}$/.test(entry),
  );
  if (isIdentifierList) {
    return (
      <details className="paper-code-disclosure paper-identifier-disclosure">
        <CodeSummary label="Benchmark instances" meta={`${identifierEntries.length} identifiers · preserved in source order`} />
        <ul className="paper-identifier-grid">
          {identifierEntries.map((entry, index) => <li key={`${entry}-${index}`}><code>{entry}</code></li>)}
        </ul>
      </details>
    );
  }

  const raw = entries.join("\n\n");
  const formatted = formatExtractedCode(raw);
  const label = classifyExtractedArtifact(raw);
  const shouldCollapse = paragraphs.length > 1 || raw.length > 600;
  if (!shouldCollapse) {
    return <pre aria-label={label} className="paper-code-block">{formatted}</pre>;
  }
  return (
    <details className="paper-code-disclosure">
      <CodeSummary label={label} meta={`${formatCharacterCount(raw.length)} · preserved for audit and export`} />
      <pre className="paper-code-block">{formatted}</pre>
    </details>
  );
}

function CodeSummary({ label, meta }: { label: string; meta: string }) {
  return (
    <summary>
      <FileCode2 aria-hidden="true" size={16} />
      <span><strong>{label}</strong><small>{meta}</small></span>
      <ChevronRight aria-hidden="true" className="disclosure-chevron" size={15} />
    </summary>
  );
}

function paragraphText(paragraph: Paragraph): string {
  return paragraph.sentences.map(sentenceText).join("\n").trim();
}

function formatCharacterCount(count: number): string {
  return count >= 1_000 ? `${(count / 1_000).toFixed(1)}k characters` : `${count} characters`;
}

function classifyExtractedArtifact(value: string): string {
  if (/(?:^|\s)diff --git\s|(?:^|\s)@@\s+-\d/m.test(value)) return "Extracted Git diff";
  if (/Coding Agent Summary/i.test(value) && /\b[a-z]+__[a-z]+-\d{3,}\b/i.test(value)) {
    return "Agent prompt and benchmark appendix";
  }
  if (/^def tool_info\s*\(/.test(value)) return "Extracted tool definition";
  if (/^(?:I'll|I will) run the tests/i.test(value)) return "Extracted agent execution trace";
  if (/^(?:Within|Augment|Add|Remove|Implement)\b/i.test(value)) return "Extracted feature prompt";
  return "Extracted technical block";
}

function formatExtractedCode(value: string): string {
  return value
    .replace(/\s+(?=diff --git\s)/g, "\n\n")
    .replace(/\s+(?=index [0-9a-f]+\.\.[0-9a-f]+\s)/gi, "\n")
    .replace(/\s+---\s*(?=(?:a\/|\/dev\/null))/g, "\n--- ")
    .replace(/\s+\+\+\+\s*(?=(?:b\/|\/dev\/null))/g, "\n+++ ")
    .replace(/\s+(?=@@\s+-\d)/g, "\n")
    .trim();
}

function SentenceView({
  sentence,
  findings,
  references,
  referenceNumbers,
  style,
}: {
  sentence: Sentence;
  findings: ReviewFinding[];
  references: Map<string, ReferenceRecord>;
  referenceNumbers: Map<string, number>;
  style: "numeric" | "author-date" | "unknown";
}) {
  const hasCitation = sentence.nodes.some((node) => node.type === "citation");
  const tone = findings.some((finding) => finding.severity === "action")
    ? "action"
    : findings.length
      ? "finding"
      : hasCitation
        ? "cited"
        : "plain";
  return (
    <span className="paper-sentence" data-tone={tone} id={`sentence-${sentence.id}`}>
      {groupInlineNodes(sentence.nodes).map((group) =>
        group.type === "text" ? (
          <span key={`${sentence.id}-${group.key}`}>{group.value}</span>
        ) : (
          <CitationCluster
            citations={group.citations}
            key={group.key}
            referenceNumbers={referenceNumbers}
            references={references}
            style={style}
          />
        ),
      )}{" "}
    </span>
  );
}

function CitationCluster({
  citations,
  references,
  referenceNumbers,
  style,
}: {
  citations: CitationNode[];
  references: Map<string, ReferenceRecord>;
  referenceNumbers: Map<string, number>;
  style: "numeric" | "author-date" | "unknown";
}) {
  const referenceIds = [...new Set(citations.flatMap((citation) => citation.referenceIds))];
  const unresolved = citations.filter((citation) => citation.referenceIds.length === 0);
  const labels = referenceIds.map((id) =>
    citationLabel(references.get(id), referenceNumbers.get(id), style),
  );
  if (unresolved.length) {
    labels.push(
      ...(style === "numeric"
        ? unresolved.map(() => "?")
        : unresolved.map((citation) => citation.raw.replace(/^[\s(;\[]+|[\s;)\]]+$/g, ""))),
    );
  }
  const href =
    !unresolved.length && referenceIds.length === 1
      ? references.get(referenceIds[0]!)?.csl.URL
      : undefined;
  const content = style === "numeric" ? `[${labels.join(", ")}]` : `(${labels.join("; ")})`;
  const title = unresolved.length
    ? `Unresolved citation text: ${unresolved.map((citation) => citation.raw).join(" ")}`
    : referenceIds.length > 1
      ? `${referenceIds.length} linked sources`
      : "Open source";
  return href ? (
    <a className="citation-anchor" href={href} rel="noreferrer" target="_blank" title={title}>{content}</a>
  ) : (
    <span className={`citation-anchor${unresolved.length ? " unresolved" : ""}`} title={title}>{content}</span>
  );
}

function citationLabel(reference: ReferenceRecord | undefined, number: number | undefined, style: string): string {
  if (style === "numeric") return String(number ?? "?");
  const authors = reference?.csl.author ?? [];
  const names = authors.map((author) => author.family ?? author.literal).filter(Boolean);
  const name = names.length > 2
    ? `${names[0]} et al.`
    : names.length === 2
      ? `${names[0]} & ${names[1]}`
      : names[0] ?? "Unresolved";
  const year = reference?.csl.issued?.["date-parts"]?.[0]?.[0] ?? "n.d.";
  return `${name}, ${year}`;
}

function CitationLibrary({
  snapshot,
  disabled,
  onStyleChange,
}: {
  snapshot: DocumentSnapshot;
  disabled: boolean;
  onStyleChange: (style: "apa" | "ieee") => Promise<void>;
}) {
  const paper = snapshot.paper;
  if (!paper) return null;
  return (
    <div className="citation-library">
      <div className="library-heading">
        <div><p className="eyebrow">Canonical model</p><h2>CSL-JSON references</h2></div>
        <label className="style-picker">
          <Braces aria-hidden="true" size={14} />
          <span className="sr-only">Citation style</span>
          <select
            aria-label="Citation style"
            disabled={disabled}
            onChange={(event) => void onStyleChange(event.target.value as "apa" | "ieee")}
            value={paper.citationStyle.cslId}
          >
            <option value="apa">APA</option>
            <option value="ieee">IEEE</option>
          </select>
        </label>
      </div>
      {paper.references.map((reference, index) => (
        <article className="reference-row" data-status={reference.status} key={reference.id}>
          <span className="reference-number">{String(index + 1).padStart(2, "0")}</span>
          <div>
            <div className="reference-meta"><span>{reference.status}</span><span>{Math.round(reference.confidence * 100)}% parse confidence</span></div>
            <h3>{reference.csl.title || reference.raw || "Unparsed reference"}</h3>
            <p>{reference.csl.author?.map((author) => author.family ?? author.literal).filter(Boolean).join(", ")}{reference.csl.issued?.["date-parts"]?.[0]?.[0] ? ` · ${reference.csl.issued["date-parts"][0]?.[0]}` : ""}</p>
            {reference.csl.DOI ? <a href={`https://doi.org/${reference.csl.DOI}`} rel="noreferrer" target="_blank">doi:{reference.csl.DOI}</a> : null}
            {reference.raw ? <details><summary>Original reference text</summary><code>{reference.raw}</code></details> : null}
          </div>
        </article>
      ))}
      {paper.warnings.map((warning) => (
        <div className="warning-row" key={`${warning.code}-${warning.anchorId ?? warning.referenceId ?? warning.message}`}>
          <AlertCircle aria-hidden="true" size={14} /><span><strong>{warning.code.replaceAll("_", " ")}</strong>{warning.message}</span>
        </div>
      ))}
    </div>
  );
}

function ChangesView({ snapshot }: { snapshot: DocumentSnapshot }) {
  const proposal = snapshot.proposal;
  return (
    <div className="changes-view">
      <p className="eyebrow">Version control</p>
      <h2>{proposal ? "One proposal is waiting" : "The approved paper is current"}</h2>
      <p>{proposal ? "Review the full diff in the reviewer pane. Nothing below has been committed." : "Approved edits create an immutable child version. Previous versions remain in SQLite for auditability."}</p>
      {proposal ? (
        <div className="change-ledger">
          {proposal.operations.map((operation, index) => (
            <div key={`${operation.type}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><strong>{operation.type.replaceAll("-", " ")}</strong><p>{operation.type === "replace-sentence" ? operation.afterText : operation.type === "add-citation" ? operation.source.title : operation.text}</p></div>
          ))}
        </div>
      ) : (
        <div className="quiet-empty"><FileDiff aria-hidden="true" size={21} /><p>No pending changes</p><span>Use the command box to propose a targeted revision.</span></div>
      )}
    </div>
  );
}
