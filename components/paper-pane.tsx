"use client";

import { AlertCircle, BookMarked, Braces, FileDiff, Layers3 } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  CitationNode,
  DocumentSnapshot,
  Paragraph,
  ReferenceRecord,
  ReviewFinding,
  Sentence,
} from "@/lib/domain";
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
  return paragraphs.map((paragraph) => (
    <p className="paper-paragraph" key={paragraph.id}>
      {paragraph.sentences.map((sentence) => (
        <SentenceView
          findings={findings.get(sentence.id) ?? []}
          key={sentence.id}
          referenceNumbers={referenceNumbers}
          references={references}
          sentence={sentence}
          style={style}
        />
      ))}
    </p>
  ));
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
      {sentence.nodes.map((node, index) =>
        node.type === "text" ? (
          <span key={`${sentence.id}-text-${index}`}>{node.value}</span>
        ) : (
          <CitationCluster
            citation={node}
            key={node.anchorId}
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
  citation,
  references,
  referenceNumbers,
  style,
}: {
  citation: CitationNode;
  references: Map<string, ReferenceRecord>;
  referenceNumbers: Map<string, number>;
  style: "numeric" | "author-date" | "unknown";
}) {
  const labels = citation.referenceIds.map((id) => citationLabel(references.get(id), referenceNumbers.get(id), style));
  const href = citation.referenceIds.map((id) => references.get(id)?.csl.URL).find(Boolean);
  const content = style === "numeric" ? `[${labels.join(", ")}]` : `(${labels.join("; ")})`;
  return href ? <a className="citation-anchor" href={href} rel="noreferrer" target="_blank" title="Open source">{content}</a> : <span className="citation-anchor unresolved" title="Unresolved citation">{content}</span>;
}

function citationLabel(reference: ReferenceRecord | undefined, number: number | undefined, style: string): string {
  if (style === "numeric") return String(number ?? "?");
  const author = reference?.csl.author?.[0];
  const name = author?.family ?? author?.literal ?? "Unresolved";
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
