import { z } from "zod";
import { errorResponse } from "@/lib/errors";
import {
  createPaperVersion,
  getCurrentPaper,
  getDocumentSnapshot,
} from "@/lib/repository";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  try {
    const { documentId } = await context.params;
    return Response.json(getDocumentSnapshot(documentId));
  } catch (error) {
    return errorResponse(error);
  }
}

const StyleRequest = z.strictObject({ style: z.enum(["apa", "ieee"]) });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  try {
    const { documentId } = await context.params;
    const { style } = StyleRequest.parse(await request.json());
    const { paper, versionId } = getCurrentPaper(documentId);
    paper.citationStyle = {
      family: style === "ieee" ? "numeric" : "author-date",
      cslId: style,
      confidence: 1,
    };
    createPaperVersion(documentId, paper, versionId);
    return Response.json(getDocumentSnapshot(documentId));
  } catch (error) {
    return errorResponse(error);
  }
}
