"use client";

import { Check, ExternalLink, Plus, Quote, X } from "lucide-react";
import type { EditProposal } from "@/lib/domain";

export function ProposalCard({
  proposal,
  onDecide,
}: {
  proposal: EditProposal;
  onDecide: (decision: "approve" | "reject") => Promise<void>;
}) {
  const pending = proposal.status === "pending";
  return (
    <article className="proposal-card">
      <div className="proposal-heading">
        <div>
          <p className="eyebrow">{pending ? "Approval required" : proposal.status === "approved" ? "Revision approved" : "Proposal rejected"}</p>
          <h3>{proposal.summary}</h3>
        </div>
        <span>{proposal.engine === "model" ? "Model planned" : "Local fallback"}</span>
      </div>
      <div className="proposal-operations">
        {proposal.operations.map((operation, index) => {
          if (operation.type === "replace-sentence") {
            return (
              <div className="operation-diff" key={`${operation.sentenceId}-${index}`}>
                <p className="operation-label"><Quote aria-hidden="true" size={14} /> Shorten sentence</p>
                <del>{operation.beforeText}</del>
                <ins>{operation.afterText}</ins>
              </div>
            );
          }
          if (operation.type === "add-citation") {
            return (
              <div className="operation-source" key={`${operation.sentenceId}-${operation.source.id}`}>
                <p className="operation-label"><Plus aria-hidden="true" size={14} /> Add verified citation</p>
                <a href={operation.source.url} rel="noreferrer" target="_blank">
                  {operation.source.title}
                  <ExternalLink aria-hidden="true" size={13} />
                </a>
                <span>{operation.source.providers.join(" + ")} · {operation.source.retrievalMethod.replaceAll("-", " ")}</span>
              </div>
            );
          }
          return (
            <div className="operation-source" key={`${operation.sectionId}-${index}`}>
              <p className="operation-label"><Plus aria-hidden="true" size={14} /> Add sourced claim</p>
              <p>{operation.text}</p>
              <a href={operation.sources[0]?.url} rel="noreferrer" target="_blank">
                {operation.sources[0]?.title}
                <ExternalLink aria-hidden="true" size={13} />
              </a>
            </div>
          );
        })}
      </div>
      {pending ? (
        <div className="proposal-actions">
          <button className="action-button secondary" onClick={() => void onDecide("reject")} type="button">
            <X aria-hidden="true" size={15} /> Reject
          </button>
          <button className="action-button" onClick={() => void onDecide("approve")} type="button">
            <Check aria-hidden="true" size={15} /> Approve revision
          </button>
        </div>
      ) : (
        <div className="proposal-decision" data-status={proposal.status}>
          {proposal.status === "approved" ? <Check aria-hidden="true" size={14} /> : <X aria-hidden="true" size={14} />}
          <span>{proposal.status === "approved" ? "Committed as a new immutable version" : "No manuscript changes were applied"}</span>
        </div>
      )}
    </article>
  );
}
