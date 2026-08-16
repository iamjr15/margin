import { z } from "zod";
import { proposeEdit } from "@/lib/edit";
import { AppError, errorResponse } from "@/lib/errors";
import {
  getCurrentPaper,
  getDocumentSnapshot,
  saveProposal,
  setDocumentStatus,
} from "@/lib/repository";

export const runtime = "nodejs";
export const maxDuration = 180;

const RequestSchema = z.strictObject({ command: z.string().trim().min(3).max(1_000) });

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const { documentId } = await context.params;
  let operationStarted = false;
  try {
    const input = RequestSchema.safeParse(await request.json());
    if (!input.success) {
      throw new AppError("invalid_command", "Enter a specific editing command.", 400);
    }
    const { paper, versionId } = getCurrentPaper(documentId);
    setDocumentStatus(documentId, "EDITING");
    operationStarted = true;
    const proposal = await proposeEdit(documentId, versionId, paper, input.data.command);
    saveProposal(proposal);
    setDocumentStatus(documentId, "READY");
    return Response.json(getDocumentSnapshot(documentId), { status: 201 });
  } catch (error) {
    if (operationStarted) setDocumentStatus(documentId, "READY");
    return errorResponse(error);
  }
}
