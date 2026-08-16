import { errorResponse } from "@/lib/errors";
import {
  getCurrentPaper,
  getDocumentSnapshot,
  saveReview,
  setDocumentStatus,
} from "@/lib/repository";
import { reviewPaper } from "@/lib/review";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(
  _request: Request,
  context: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const { documentId } = await context.params;
  let operationStarted = false;
  try {
    const { paper, versionId } = getCurrentPaper(documentId);
    setDocumentStatus(documentId, "REVIEWING");
    operationStarted = true;
    const review = await reviewPaper(documentId, versionId, paper);
    saveReview(review);
    setDocumentStatus(documentId, "READY");
    return Response.json(getDocumentSnapshot(documentId));
  } catch (error) {
    if (operationStarted) setDocumentStatus(documentId, "READY");
    return errorResponse(error);
  }
}
