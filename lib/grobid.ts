import { AppError } from "@/lib/errors";

const DEFAULT_TIMEOUT_MS = 120_000;

export async function parsePdfWithGrobid(pdf: Uint8Array, filename: string): Promise<string> {
  const url = `${process.env.GROBID_URL ?? "http://127.0.0.1:8070"}/api/processFulltextDocument`;
  const response = await requestGrobid(url, pdf, filename);
  if (response.status === 503) {
    await wait(5_000);
    return parseSuccessfulResponse(await requestGrobid(url, pdf, filename));
  }
  return parseSuccessfulResponse(response);
}

async function requestGrobid(url: string, pdf: Uint8Array, filename: string): Promise<Response> {
  const form = new FormData();
  const upload = pdf.slice().buffer as ArrayBuffer;
  form.append("input", new Blob([upload], { type: "application/pdf" }), filename);
  form.append("consolidateHeader", "0");
  form.append("consolidateCitations", "0");
  form.append("includeRawCitations", "1");
  form.append("generateIDs", "1");
  form.append("segmentSentences", "1");
  for (const structure of ["ref", "biblStruct", "head", "p", "s"]) {
    form.append("teiCoordinates", structure);
  }
  try {
    return await fetch(url, {
      method: "POST",
      headers: { Accept: "application/xml" },
      body: form,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError(
      "grobid_unavailable",
      "The scholarly parser is unavailable. Start the GROBID service and try again.",
      503,
      error instanceof Error ? error.message : undefined,
    );
  }
}

async function parseSuccessfulResponse(response: Response): Promise<string> {
  if (response.status === 204) {
    throw new AppError(
      "needs_ocr",
      "No extractable text was found. This PDF may be scanned and needs OCR.",
      422,
    );
  }
  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    throw new AppError(
      response.status === 503 ? "grobid_saturated" : "grobid_parse_failed",
      response.status === 503
        ? "The parser is busy. Try again shortly."
        : "The PDF could not be parsed as a scholarly document.",
      response.status === 503 ? 503 : 422,
      details,
    );
  }
  const xml = await response.text();
  if (!xml.includes("<TEI")) {
    throw new AppError("invalid_tei", "The parser returned an invalid document.", 502);
  }
  return xml;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
