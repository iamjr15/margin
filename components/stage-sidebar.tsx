"use client";

import { Download, FileText, RotateCcw, ShieldCheck } from "lucide-react";
import type { DocumentSnapshot } from "@/lib/domain";

interface Props {
  snapshot: DocumentSnapshot | null;
  busy: boolean;
  onExport: () => void;
  onReset: () => void;
}

const STAGES = ["Upload", "Parse", "Review", "Revise", "Export"] as const;

export function StageSidebar({ snapshot, busy, onExport, onReset }: Props) {
  const completed = completedStages(snapshot);
  const active = activeStage(snapshot);
  return (
    <aside className="panel stage-panel">
      <div className="brand-lockup">
        <span aria-hidden="true" className="margin-mark"><span /></span>
        <div>
          <p className="brand-name">Margin</p>
          <p className="brand-subtitle">Evidence-first review</p>
        </div>
      </div>

      <div className="stage-document">
        <p className="eyebrow">Current manuscript</p>
        {snapshot ? (
          <>
            <FileText aria-hidden="true" size={17} />
            <p title={snapshot.filename}>{snapshot.filename}</p>
            <button aria-label="Upload a different paper" onClick={onReset} type="button">
              <RotateCcw aria-hidden="true" size={15} />
            </button>
          </>
        ) : (
          <p className="empty-document">No paper loaded</p>
        )}
      </div>

      <ol className="stage-list">
        {STAGES.map((stage, index) => (
          <li aria-current={stage === active ? "step" : undefined} key={stage}>
            <span
              aria-hidden="true"
              className={`status-dot ${completed.includes(stage) ? "complete" : stage === active ? "active" : ""}`}
            />
            <span className="stage-index">0{index + 1}</span>
            <span>{stage}</span>
          </li>
        ))}
      </ol>

      <div className="sidebar-bottom">
        <div className="integrity-note">
          <ShieldCheck aria-hidden="true" size={17} />
          <div>
            <p>Citation integrity</p>
            <span>Existing anchors are immutable across edits.</span>
          </div>
        </div>
        <button
          className="action-button export-button"
          disabled={!snapshot?.paper || busy}
          onClick={onExport}
          type="button"
        >
          <Download aria-hidden="true" size={16} />
          Export revision
        </button>
      </div>
    </aside>
  );
}

function completedStages(snapshot: DocumentSnapshot | null): string[] {
  if (!snapshot) return [];
  const complete = ["Upload"];
  if (snapshot.paper) complete.push("Parse");
  if (snapshot.review || snapshot.versionCount > 1) complete.push("Review");
  if (snapshot.versionCount > 1) complete.push("Revise");
  return complete;
}

function activeStage(snapshot: DocumentSnapshot | null): string {
  if (!snapshot) return "Upload";
  if (!snapshot.paper) return "Parse";
  if (snapshot.versionCount > 1) return "Export";
  if (!snapshot.review) return "Review";
  if (!snapshot.proposal) return "Revise";
  return "Export";
}
