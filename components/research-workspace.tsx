"use client";

import { useState } from "react";
import {
  type DocumentSnapshot,
  DocumentSnapshotSchema,
  type EditProposal,
  type ReviewResult,
} from "@/lib/domain";
import { CommandComposer } from "@/components/command-composer";
import { PaperPane } from "@/components/paper-pane";
import { ReviewPane } from "@/components/review-pane";
import { StageSidebar } from "@/components/stage-sidebar";

type MobileView = "review" | "paper";

export function ResearchWorkspace() {
  const [snapshot, setSnapshot] = useState<DocumentSnapshot | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<MobileView>("paper");
  const [paperOpen, setPaperOpen] = useState(true);
  const [threadReview, setThreadReview] = useState<ReviewResult | null>(null);
  const [threadProposal, setThreadProposal] = useState<EditProposal | null>(null);

  const upload = async (file: File) => {
    setBusyLabel("Parsing the paper into linked sections and citations…");
    setError(null);
    const form = new FormData();
    form.append("paper", file);
    try {
      const response = await fetch("/api/documents", { method: "POST", body: form });
      const payload = (await response.json()) as unknown;
      const candidate = response.ok ? payload : nestedSnapshot(payload);
      const parsed = DocumentSnapshotSchema.safeParse(candidate);
      if (parsed.success) setSnapshot(parsed.data);
      if (!response.ok) throw new Error(apiMessage(payload));
      setThreadReview(null);
      setThreadProposal(null);
      setMobileView("paper");
      setPaperOpen(true);
    } catch (uploadError) {
      setError(messageFrom(uploadError));
    } finally {
      setBusyLabel(null);
    }
  };

  const runReview = async () => {
    if (!snapshot) return;
    await mutateSnapshot(
      `/api/documents/${snapshot.id}/review`,
      { method: "POST" },
      "Resolving cited works, searching both academic indexes, and checking claim evidence…",
      "review",
    );
  };

  const propose = async (command: string) => {
    if (!snapshot) return;
    await mutateSnapshot(
      `/api/documents/${snapshot.id}/proposals`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      },
      "Planning and validating a citation-safe change…",
      "review",
    );
  };

  const decide = async (decision: "approve" | "reject") => {
    if (!snapshot?.proposal) return;
    const proposal = snapshot.proposal;
    const next = await mutateSnapshot(
      `/api/documents/${snapshot.id}/proposals/${snapshot.proposal.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      },
      decision === "approve" ? "Validating and committing a new paper version…" : "Discarding the proposal…",
      decision === "approve" ? "paper" : "review",
    );
    if (next) {
      setThreadProposal({
        ...proposal,
        status: decision === "approve" ? "approved" : "rejected",
        decidedAt: new Date().toISOString(),
      });
    }
  };

  const changeStyle = async (style: "apa" | "ieee") => {
    if (!snapshot) return;
    await mutateSnapshot(
      `/api/documents/${snapshot.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style }),
      },
      "Applying the selected CSL style…",
      "paper",
    );
  };

  const exportBundle = async () => {
    if (!snapshot) return;
    setBusyLabel("Validating citations and typesetting the export bundle…");
    setError(null);
    try {
      const response = await fetch(`/api/documents/${snapshot.id}/export`, { method: "POST" });
      if (!response.ok) throw new Error(apiMessage(await response.json()));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filenameFromDisposition(response.headers.get("content-disposition"));
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(messageFrom(exportError));
      setMobileView("paper");
    } finally {
      setBusyLabel(null);
    }
  };

  const mutateSnapshot = async (
    url: string,
    init: RequestInit,
    label: string,
    nextView: MobileView,
  ): Promise<DocumentSnapshot | null> => {
    setBusyLabel(label);
    setError(null);
    try {
      const response = await fetch(url, init);
      const payload = (await response.json()) as unknown;
      if (!response.ok) throw new Error(apiMessage(payload));
      const next = DocumentSnapshotSchema.parse(payload);
      setSnapshot(next);
      if (next.review) setThreadReview(next.review);
      if (next.proposal) setThreadProposal(next.proposal);
      setMobileView(nextView);
      return next;
    } catch (mutationError) {
      setError(messageFrom(mutationError));
      return null;
    } finally {
      setBusyLabel(null);
    }
  };

  return (
    <main className="workspace-shell" id="main-content">
      <div
        className="workspace-grid"
        data-has-paper={Boolean(snapshot?.paper)}
        data-paper-open={Boolean(snapshot?.paper && paperOpen)}
      >
        <StageSidebar
          busy={Boolean(busyLabel)}
          onExport={exportBundle}
          onReset={() => {
            setSnapshot(null);
            setError(null);
            setThreadReview(null);
            setThreadProposal(null);
            setMobileView("paper");
            setPaperOpen(true);
          }}
          onShowThread={() => {
            setMobileView("review");
            setPaperOpen(false);
          }}
          onTogglePaper={() => {
            setMobileView("paper");
            setPaperOpen((open) => !open);
          }}
          paperOpen={paperOpen}
          snapshot={snapshot}
        />
        {!snapshot?.paper ? (
          <section aria-label="Upload a research paper" className="launch-panel">
            <PaperPane
              busyLabel={busyLabel}
              error={error}
              onStyleChange={changeStyle}
              onUpload={upload}
              snapshot={snapshot}
            />
          </section>
        ) : (
          <>
            <nav aria-label="Workspace views" className="mobile-tabs">
              <button
                aria-pressed={mobileView === "review"}
                className={mobileView === "review" ? "active" : ""}
                onClick={() => setMobileView("review")}
                type="button"
              >
                Thread
              </button>
              <button
                aria-pressed={mobileView === "paper"}
                className={mobileView === "paper" ? "active" : ""}
                onClick={() => setMobileView("paper")}
                type="button"
              >
                Manuscript
              </button>
            </nav>
            <section
              aria-label="Review thread and editing"
              className="review-panel"
              data-mobile-visible={mobileView === "review"}
              id="review-thread"
              tabIndex={-1}
            >
              <ReviewPane
                busyLabel={busyLabel}
                error={error}
                onDecide={decide}
                onReview={runReview}
                snapshot={{
                  ...snapshot,
                  review: snapshot.review ?? threadReview,
                  proposal: snapshot.proposal ?? threadProposal,
                }}
              />
              <CommandComposer
                disabled={Boolean(busyLabel) || Boolean(snapshot.proposal)}
                onSubmit={propose}
                placeholder={
                  snapshot.proposal
                    ? "Approve or reject the current proposal first"
                    : busyLabel ?? "Ask Margin to improve this paper…"
                }
              />
            </section>
            <section
              aria-label="Parsed manuscript artifact"
              className="paper-panel"
              data-mobile-visible={mobileView === "paper"}
            >
              <PaperPane
                busyLabel={busyLabel}
                error={error}
                onStyleChange={changeStyle}
                onUpload={upload}
                snapshot={snapshot}
              />
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function nestedSnapshot(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("snapshot" in payload)) return null;
  return (payload as { snapshot: unknown }).snapshot;
}

function apiMessage(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return "The operation could not be completed.";
  }
  const error = (payload as { error: unknown }).error;
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return "The operation could not be completed.";
  }
  const record = error as { message: unknown; details?: unknown };
  const message = String(record.message);
  const details = typeof record.details === "string"
    ? record.details.replace(/\s+/g, " ").slice(0, 320)
    : "";
  return details ? `${message} Technical detail: ${details}` : message;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "The operation could not be completed.";
}

function filenameFromDisposition(value: string | null): string {
  return value?.match(/filename="([^"]+)"/)?.[1] ?? "revised-paper.zip";
}
