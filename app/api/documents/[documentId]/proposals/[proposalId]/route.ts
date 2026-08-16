import { z } from "zod";
import { applyProposal } from "@/lib/edit";
import { AppError, errorResponse } from "@/lib/errors";
import {
  approveProposal,
  decideProposal,
  getCurrentPaper,
  getDocumentSnapshot,
  getProposal,
} from "@/lib/repository";

export const runtime = "nodejs";

const DecisionSchema = z.strictObject({ decision: z.enum(["approve", "reject"]) });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ documentId: string; proposalId: string }> },
): Promise<Response> {
  try {
    const { documentId, proposalId } = await context.params;
    const input = DecisionSchema.safeParse(await request.json());
    if (!input.success) throw new AppError("invalid_decision", "Choose approve or reject.", 400);
    const proposal = getProposal(proposalId);
    if (proposal.documentId !== documentId) {
      throw new AppError("proposal_not_found", "Edit proposal not found.", 404);
    }
    if (proposal.status !== "pending") {
      throw new AppError("proposal_already_decided", "This proposal was already decided.", 409);
    }
    if (input.data.decision === "reject") {
      decideProposal({
        ...proposal,
        status: "rejected",
        decidedAt: new Date().toISOString(),
      });
      return Response.json(getDocumentSnapshot(documentId));
    }
    const current = getCurrentPaper(documentId);
    if (current.versionId !== proposal.baseVersionId) {
      throw new AppError(
        "stale_proposal",
        "The paper changed after this proposal was created. Generate a new proposal.",
        409,
      );
    }
    const revised = applyProposal(current.paper, proposal.operations);
    approveProposal(proposal, revised);
    return Response.json(getDocumentSnapshot(documentId));
  } catch (error) {
    return errorResponse(error);
  }
}
