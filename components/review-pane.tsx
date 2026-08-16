"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  BookOpenCheck,
  Check,
  ChevronRight,
  FileText,
  Search,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DocumentSnapshot, ReviewFinding, WorkSource } from "@/lib/domain";
import { ProposalCard } from "@/components/proposal-card";

interface Props {
  snapshot: DocumentSnapshot | null;
  busyLabel: string | null;
  error: string | null;
  onReview: () => Promise<void>;
  onDecide: (decision: "approve" | "reject") => Promise<void>;
}

export function ReviewPane({ snapshot, busyLabel, error, onReview, onDecide }: Props) {
  const busyAnchor = useRef<HTMLDivElement>(null);
  const reviewAnchor = useRef<HTMLDivElement>(null);
  const proposalAnchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = snapshot?.proposal
      ? proposalAnchor.current
      : busyLabel
        ? busyAnchor.current
        : snapshot?.review
          ? reviewAnchor.current
          : null;
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [busyLabel, snapshot?.proposal?.id, snapshot?.review?.id]);

  if (!snapshot?.paper) return null;
  const sourceMap = new Map(snapshot.review?.sources.map((source) => [source.id, source]) ?? []);
  const paper = snapshot.paper;

  return (
    <div className="review-layout">
      <header className="thread-toolbar">
        <button className="thread-title" title={snapshot.filename} type="button">
          <FileText aria-hidden="true" size={13} />
          <span>{snapshot.filename}</span>
        </button>
        <div className="thread-meta">
          <span>v{snapshot.versionCount}</span>
          <span>{paper.references.length} references</span>
        </div>
      </header>

      <div className="panel-scroll review-scroll">
        <div className="thread-flow">
          <article className="user-turn">
            <p>Review this manuscript and preserve its citations.</p>
            <span>{snapshot.filename} · PDF</span>
          </article>

          <ParseTrace snapshot={snapshot} />

          {error ? (
            <div className="thread-error" role="alert">
              <AlertTriangle aria-hidden="true" size={16} />
              <div><strong>Action needed</strong><p>{error}</p></div>
            </div>
          ) : null}

          {busyLabel ? <><div className="thread-anchor" ref={busyAnchor} /><BusyState label={busyLabel} /></> : null}

          {!snapshot.review && !snapshot.proposal && !busyLabel ? (
            <AssistantTurn>
              <p className="assistant-kicker">Manuscript ready</p>
              <h2>I mapped the paper into linked claims, citations, and references.</h2>
              <p>Next, I can search Semantic Scholar and OpenAlex, identify missing work, and check cited claims against available abstracts.</p>
              <button className="thread-primary-action" onClick={() => void onReview()} type="button">
                <Search aria-hidden="true" size={15} /> Run evidence review
              </button>
            </AssistantTurn>
          ) : null}

          {snapshot.review ? (
            <>
              <div className="thread-anchor" ref={reviewAnchor} />
              <article className="user-turn compact">
                <p>Check the claims, find missing work, and show the evidence.</p>
              </article>
              <ProviderTrace snapshot={snapshot} />
              <AssistantTurn>
                <div className="assistant-heading">
                  <div><p className="assistant-kicker">Evidence review</p><h2>{reviewHeadline(snapshot.review.findings.length)}</h2></div>
                  <button className="thread-icon-action" disabled={Boolean(busyLabel)} onClick={() => void onReview()} title="Run review again" type="button">
                    <Search aria-hidden="true" size={14} />
                  </button>
                </div>
                <ReviewSummary snapshot={snapshot} />
                <div className="finding-list">
                  {snapshot.review.findings.map((finding) => (
                    <FindingCard finding={finding} key={finding.id} sourceMap={sourceMap} />
                  ))}
                  {snapshot.review.findings.length === 0 ? (
                    <div className="quiet-empty">
                      <BookOpenCheck aria-hidden="true" size={20} />
                      <p>No actionable findings passed the evidence checks.</p>
                      <span>This does not prove the manuscript is complete.</span>
                    </div>
                  ) : null}
                </div>
                <details className="limitations">
                  <summary>Review limitations</summary>
                  <ul>{snapshot.review.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
                </details>
              </AssistantTurn>
            </>
          ) : null}

          {snapshot.proposal ? (
            <>
              <div className="thread-anchor" ref={proposalAnchor} />
              <article className="user-turn compact"><p>{snapshot.proposal.command}</p></article>
              <AssistantTurn><ProposalCard onDecide={onDecide} paper={paper} proposal={snapshot.proposal} /></AssistantTurn>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AssistantTurn({ children }: { children: React.ReactNode }) {
  return (
    <article className="assistant-turn">
      <div aria-hidden="true" className="assistant-mark"><Sparkles size={14} /></div>
      <div className="assistant-content">{children}</div>
    </article>
  );
}

function ParseTrace({ snapshot }: { snapshot: DocumentSnapshot }) {
  const paper = snapshot.paper;
  if (!paper) return null;
  return (
    <details className="tool-trace">
      <summary><Check aria-hidden="true" size={13} /><span>Parsed manuscript</span><small>{paper.sections.length} sections · {paper.references.length} references</small><ChevronRight aria-hidden="true" size={13} /></summary>
      <div className="trace-body">
        <p><span>GROBID</span> Structured the PDF into TEI and stable sentence IDs.</p>
        <p><span>CSL-JSON</span> Normalized {paper.references.length} bibliography records.</p>
        {paper.provenance.recoveredPseudoHeadings ? (
          <p><span>Recovery</span> Preserved {paper.provenance.recoveredPseudoHeadings} parser-created pseudo-headings as text/code blocks.</p>
        ) : null}
        <p><span>Integrity</span> Retained {paper.warnings.length} visible parse warning{paper.warnings.length === 1 ? "" : "s"}.</p>
      </div>
    </details>
  );
}

function ProviderTrace({ snapshot }: { snapshot: DocumentSnapshot }) {
  const review = snapshot.review;
  if (!review) return null;
  return (
    <details className="tool-trace">
      <summary><Check aria-hidden="true" size={13} /><span>Called 2 research providers</span><small>{review.engine === "model" ? "Model synthesis" : "Deterministic fallback"}</small><ChevronRight aria-hidden="true" size={13} /></summary>
      <div className="trace-body provider-trace">
        <p><i data-status={review.providerStatus.semanticScholar} /><span>Semantic Scholar</span>{review.providerStatus.semanticScholar}</p>
        <p><i data-status={review.providerStatus.openAlex} /><span>OpenAlex</span>{review.providerStatus.openAlex}</p>
        <p><span>Grounding</span> Source IDs and quoted abstract evidence were validated before display.</p>
      </div>
    </details>
  );
}

function BusyState({ label }: { label: string }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    setElapsedSeconds(0);
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [label]);
  const reviewSteps = /academic|cited|claim|evidence/i.test(label)
    ? [
        "Batch-resolve cited DOI and provider IDs",
        "Search Semantic Scholar and OpenAlex",
        "Remove duplicates and the uploaded paper",
        "Check claims against available abstracts",
        "Validate source IDs and quoted evidence",
      ]
    : [];
  const currentStep = Math.min(reviewSteps.length - 1, Math.floor(elapsedSeconds / 5));
  return (
    <div className="thread-working" aria-live="polite">
      <span aria-hidden="true" className="working-spinner" />
      <div>
        <strong>Working · {elapsedSeconds}s</strong>
        <p>{label}</p>
        {reviewSteps.length ? (
          <ol className="review-progress-steps">
            {reviewSteps.map((step, index) => (
              <li data-state={index < currentStep ? "complete" : index === currentStep ? "active" : "queued"} key={step}>
                <span aria-hidden="true" />{step}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </div>
  );
}

function ReviewSummary({ snapshot }: { snapshot: DocumentSnapshot }) {
  const review = snapshot.review;
  if (!review) return null;
  return (
    <div className="review-summary">
      <div><span>{review.findings.length}</span><p>findings</p></div>
      <div><span>{review.sources.length}</span><p>real sources</p></div>
      <div><span>{snapshot.paper?.warnings.length ?? 0}</span><p>parse flags</p></div>
      <span className="engine-label">{review.engine === "model" ? "OpenAI reviewed · provider-grounded" : "Local fallback · provider-grounded"}</span>
    </div>
  );
}

function FindingCard({
  finding,
  sourceMap,
}: {
  finding: ReviewFinding;
  sourceMap: Map<string, WorkSource>;
}) {
  const sources = finding.sourceIds.map((id) => sourceMap.get(id)).filter((source): source is WorkSource => Boolean(source));
  return (
    <article className="finding-card" data-severity={finding.severity}>
      <div className="finding-meta"><span>{finding.kind === "missing-work" ? "Missing work" : finding.verdict?.replaceAll("_", " ")}</span></div>
      <h3>{finding.title}</h3>
      <p>{finding.rationale}</p>
      {finding.evidence ? <blockquote>“{finding.evidence}”</blockquote> : null}
      {sources.map((source) => (
        <a className="finding-source" href={source.url} key={source.id} rel="noreferrer" target="_blank">
          <div>
            <strong>{source.title}</strong>
            <span>{source.authors.slice(0, 2).join(", ")}{source.year ? ` · ${source.year}` : ""}</span>
            <em>{source.providers.join(" + ")} · {source.retrievalMethod.replaceAll("-", " ")}</em>
          </div>
          <ArrowUpRight aria-hidden="true" size={14} />
        </a>
      ))}
    </article>
  );
}

function reviewHeadline(count: number): string {
  if (count === 0) return "No finding cleared the evidence threshold.";
  if (count === 1) return "One issue deserves the author’s attention.";
  return `${count} evidence-backed findings deserve attention.`;
}
