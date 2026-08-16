"use client";

import {
  Download,
  FileText,
  Menu,
  MessageCircle,
  PanelRight,
  Plus,
  X,
} from "lucide-react";
import { useState } from "react";
import type { DocumentSnapshot } from "@/lib/domain";

interface Props {
  snapshot: DocumentSnapshot | null;
  busy: boolean;
  paperOpen: boolean;
  onExport: () => void;
  onReset: () => void;
  onShowThread: () => void;
  onTogglePaper: () => void;
}

const STAGES = ["Upload", "Parse", "Review", "Revise", "Export"] as const;

export function StageSidebar({
  snapshot,
  busy,
  paperOpen,
  onExport,
  onReset,
  onShowThread,
  onTogglePaper,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const completed = completedStages(snapshot);
  const active = activeStage(snapshot);

  return (
    <aside className="stage-panel" data-expanded={expanded}>
      <div className="rail-top">
        <button
          aria-label={expanded ? "Collapse workspace rail" : "Expand workspace rail"}
          className="rail-brand"
          onClick={() => setExpanded((value) => !value)}
          title={expanded ? "Collapse" : "Expand"}
          type="button"
        >
          <span aria-hidden="true" className="margin-mark"><span /></span>
          <span className="rail-label brand-name">Margin</span>
          {expanded ? <X aria-hidden="true" className="rail-close" size={15} /> : <Menu aria-hidden="true" className="rail-menu" size={12} />}
        </button>
      </div>

      <nav aria-label="Workspace" className="rail-navigation">
        <RailButton icon={<Plus size={16} />} label="New paper" onClick={onReset} />
        <RailButton active={Boolean(snapshot?.paper && !paperOpen)} icon={<MessageCircle size={16} />} label="Review thread" onClick={onShowThread} />
        <RailButton
          active={Boolean(snapshot?.paper && paperOpen)}
          disabled={!snapshot?.paper}
          icon={<PanelRight size={16} />}
          label="Manuscript"
          onClick={onTogglePaper}
        />
        <RailButton
          disabled={!snapshot?.paper || busy}
          icon={<Download size={16} />}
          label="Export revision"
          onClick={onExport}
        />
      </nav>

      {expanded ? (
        <div className="rail-drawer">
          <p className="drawer-label">Current paper</p>
          {snapshot ? (
            <div className="drawer-document">
              <FileText aria-hidden="true" size={16} />
              <div><strong title={snapshot.filename}>{snapshot.filename}</strong><span>{snapshot.versionCount} version{snapshot.versionCount === 1 ? "" : "s"}</span></div>
            </div>
          ) : (
            <p className="drawer-empty">Upload a PDF to start a review thread.</p>
          )}
          <ol className="stage-list">
            {STAGES.map((stage, index) => (
              <li aria-current={stage === active ? "step" : undefined} key={stage}>
                <span className={`status-dot ${completed.includes(stage) ? "complete" : stage === active ? "active" : ""}`} />
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{stage}</strong>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </aside>
  );
}

function RailButton({
  active = false,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {icon}<span className="rail-label">{label}</span>
    </button>
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
