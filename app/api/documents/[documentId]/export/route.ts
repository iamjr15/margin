import { exportPaper } from "@/lib/export";
import { errorResponse } from "@/lib/errors";
import { getCurrentPaper, setDocumentStatus } from "@/lib/repository";

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
    setDocumentStatus(documentId, "EXPORTING");
    operationStarted = true;
    const bundle = await exportPaper(documentId, versionId, paper);
    setDocumentStatus(documentId, "READY");
    return new Response(bundle.bytes.slice().buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${bundle.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (operationStarted) setDocumentStatus(documentId, "READY");
    return errorResponse(error);
  }
}
