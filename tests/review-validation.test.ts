import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "@/lib/domain";
import { finalizeReviewFindings } from "@/lib/review";

describe("review finding validation", () => {
  it("rejects cited works from missing-work suggestions and deduplicates discoveries", () => {
    const findings: ReviewFinding[] = [
      finding("missing-work", "already-cited", "claim-1"),
      finding("missing-work", "new-work", "claim-1"),
      finding("missing-work", "new-work", "claim-2"),
      finding("citation-match", "already-cited", "claim-1"),
    ];

    expect(finalizeReviewFindings(findings, new Set(["new-work"]))).toEqual([
      findings[1],
      findings[3],
    ]);
  });
});

function finding(
  kind: ReviewFinding["kind"],
  sourceId: string,
  sentenceId: string,
): ReviewFinding {
  return {
    id: `${kind}-${sourceId}-${sentenceId}`,
    kind,
    severity: "attention",
    title: "Finding",
    rationale: "Validated rationale.",
    sentenceId,
    sourceIds: [sourceId],
    ...(kind === "citation-match" ? { verdict: "SUPPORTED" as const } : {}),
  };
}
