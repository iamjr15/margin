"use client";

import { AlertTriangle, ArrowUpRight, BookOpenCheck, Database, Search } from "lucide-react";
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
  const sourceMap = new Map(snapshot?.review?.sources.map((source) => [source.id, source]) ?? []);
  return (
    <div className="review-layout">
      <header className="pane-header">
        <div>
          <p className="eyebrow">Reviewer desk</p>
          <h2>Evidence and changes</h2>
        </div>
        {snapshot?.paper ? (
          <button
            className="action-button secondary compact"
            disabled={Boolean(busyLabel)}
            onClick={() => void onReview()}
            type="button"
          >
            <Search aria-hidden="true" size={14} />
            {snapshot.review ? "Review again" : "Run peer review"}
          </button>
        ) : null}
      </header>

      <div className="panel-scroll review-scroll">
        <div aria-atomic="true" aria-live="polite">
          {busyLabel ? <BusyState label={busyLabel} /> : null}
          {error ? (
            <div className="error-banner" role="alert">
              <AlertTriangle aria-hidden="true" size={17} />
              <div><strong>Action needed</strong><p>{error}</p></div>
            </div>
          ) : null}
        </div>

        {!snapshot ? <EvidenceContract /> : null}
        {snapshot?.proposal ? <ProposalCard onDecide={onDecide} proposal={snapshot.proposal} /> : null}
        {snapshot?.paper && !snapshot.review && !snapshot.proposal && !busyLabel ? <ReviewEmpty /> : null}
        {snapshot?.review ? (
          <>
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
          </>
        ) : null}
      </div>
    </div>
  );
}

function EvidenceContract() {
  return (
    <div className="evidence-contract">
      <p className="eyebrow">Trust contract</p>
      <h3>Every conclusion has a visible route back to evidence.</h3>
      <ol>
        <li><span>01</span><div><strong>Parse without hiding failure</strong><p>Unlinked markers and incomplete references remain visible.</p></div></li>
        <li><span>02</span><div><strong>Search two academic indexes</strong><p>Provider and retrieval method appear beside each source.</p></div></li>
        <li><span>03</span><div><strong>Approve before changing text</strong><p>The current paper remains immutable until you accept a diff.</p></div></li>
      </ol>
    </div>
  );
}

function ReviewEmpty() {
  return (
    <div className="review-empty">
      <Database aria-hidden="true" size={22} />
      <h3>The parse is ready to review</h3>
      <p>Search Semantic Scholar and OpenAlex for missing work, then check cited claims against available abstracts.</p>
    </div>
  );
}

function BusyState({ label }: { label: string }) {
  return (
    <div className="busy-card">
      <div className="busy-pulse"><span /><span /><span /></div>
      <div><strong>{label}</strong><p>Partial provider failures will be shown instead of hidden.</p></div>
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
      <div className="provider-state">
        <p><i data-status={review.providerStatus.semanticScholar} /> Semantic Scholar</p>
        <p><i data-status={review.providerStatus.openAlex} /> OpenAlex</p>
      </div>
      <span className="engine-label">{review.engine === "model" ? "Model reviewed" : "Fallback review"}</span>
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
      <div className="finding-meta">
        <span>{finding.kind === "missing-work" ? "Missing work" : finding.verdict?.replaceAll("_", " ")}</span>
      </div>
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
          <ArrowUpRight aria-hidden="true" size={15} />
        </a>
      ))}
    </article>
  );
}
