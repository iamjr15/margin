import { createHash } from "node:crypto";
import { AppError, errorResponse } from "@/lib/errors";
import { parsePdfWithGrobid } from "@/lib/grobid";
import {
  createDocument,
  createPaperVersion,
  getDocumentSnapshot,
  setDocumentFailure,
  setDocumentStatus,
} from "@/lib/repository";
import { writeDocumentArtifact } from "@/lib/storage";
import { projectTeiToPaper } from "@/lib/tei-projector";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request): Promise<Response> {
  let documentId: string | null = null;
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError("invalid_upload", "Send the paper as multipart form data.", 400);
    }
    const upload = form.get("paper");
    if (!(upload instanceof File)) {
      throw new AppError("pdf_required", "Choose a PDF research paper to continue.", 400);
    }
    const bytes = new Uint8Array(await upload.arrayBuffer());
    validatePdf(upload, bytes);
    const filename = safeFilename(upload.name);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    documentId = createDocument(filename, sha256);
    await writeDocumentArtifact(documentId, "source.pdf", bytes);
    setDocumentStatus(documentId, "PARSING");

    const tei = await parsePdfWithGrobid(bytes, filename);
    await writeDocumentArtifact(documentId, "source.tei.xml", tei);
    const paper = projectTeiToPaper(tei, sha256);
    createPaperVersion(documentId, paper);
    return Response.json(getDocumentSnapshot(documentId), { status: 201 });
  } catch (error) {
    if (!documentId) return errorResponse(error);
    const appError =
      error instanceof AppError
        ? error
        : new AppError("parse_failed", "The paper could not be parsed.", 500);
    setDocumentFailure(
      documentId,
      appError.code === "needs_ocr" ? "NEEDS_OCR" : "FAILED",
      appError.code,
      appError.message,
    );
    return Response.json(
      { snapshot: getDocumentSnapshot(documentId), error: { code: appError.code, message: appError.message } },
      { status: appError.status },
    );
  }
}

function validatePdf(file: File, bytes: Uint8Array): void {
  const maxBytes = Number(process.env.MAX_PDF_BYTES ?? 20 * 1024 * 1024);
  if (bytes.byteLength === 0) throw new AppError("pdf_empty", "The selected PDF is empty.", 400);
  if (bytes.byteLength > maxBytes) {
    throw new AppError(
      "pdf_too_large",
      `The PDF exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB upload limit.`,
      413,
    );
  }
  const signature = new TextDecoder("ascii").decode(bytes.slice(0, 5));
  if (signature !== "%PDF-") {
    throw new AppError("pdf_invalid", "The selected file is not a valid PDF.", 415);
  }
  if (file.type && file.type !== "application/pdf") {
    throw new AppError("pdf_invalid_type", "Only PDF files are supported.", 415);
  }
}

function safeFilename(filename: string): string {
  const sanitized = filename.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 160);
  return sanitized.toLowerCase().endsWith(".pdf") ? sanitized : `${sanitized}.pdf`;
}
